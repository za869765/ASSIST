// LINE Messaging API webhook 入口
// M1：簽章驗證 + 管理員白名單 + ping / whoami
// M3：群組任務模式（開始/進度/結單 + Gemini 抽欄位 + 非管理員訊息收集）
// 閒聊：非 M1/M3 指令的「秘書 xxx」→ Gemini 日常回應

import {
  verifyLineSignature, lineReply, isAdmin, isWakeword, stripWakeword,
  getGroupMemberProfile, getUserProfile,
} from './_lib.js';
import { geminiChat, geminiExtract, geminiIntent, geminiClassifyTask } from './_gemini.js';
import {
  findOpenTask, findOpenTasks, matchTaskByHint,
  createTask, closeTask, upsertEntry, listEntries, summarizeEntries,
} from './_tasks.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.text();
  const signature = request.headers.get('x-line-signature') || '';

  const valid = await verifyLineSignature(env.LINE_CHANNEL_SECRET, body, signature);
  if (!valid) return new Response('invalid signature', { status: 401 });

  const payload = JSON.parse(body);
  const events = payload.events || [];

  context.waitUntil(Promise.all(events.map(ev => handleEvent(ev, env).catch(e => {
    console.error('[event error]', e, ev);
  }))));

  return new Response('ok', { status: 200 });
}

async function handleEvent(ev, env) {
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const text = ev.message.text || '';
  const userId = ev.source.userId;
  const groupId = ev.source.groupId || null;
  const replyToken = ev.replyToken;

  if (userId) {
    await upsertMemberSighting(env.DB, userId, groupId, env.LINE_CHANNEL_ACCESS_TOKEN);
  }

  const admin = isAdmin(userId, env);
  const hasWake = isWakeword(text);

  // ─── 非喚醒訊息：只有群組 + 該群有 open task 時收集 ───
  if (!hasWake) {
    if (!groupId) return;
    const tasks = await findOpenTasks(env.DB, groupId);
    if (!tasks.length) return;
    let target = tasks[0];
    if (tasks.length > 1) {
      const names = tasks.map(t => t.task_name);
      const { task_name } = await geminiClassifyTask(env.GEMINI_API_KEY, names, text);
      const picked = (task_name ? matchTaskByHint(tasks, task_name) : null) || tasks[0];
      target = picked;
    }
    await collectEntry(env, target, userId, text, replyToken);
    return;
  }

  // ─── 喚醒訊息 ───
  const cmd = stripWakeword(text);

  // 自助查 userId（所有人可用）
  if (/^我的\s*ID$/i.test(cmd) || /whoami/i.test(cmd)) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `您的 userId：\n${userId}\n\n請把這組字串給管理員加入白名單。` },
    ]);
    return;
  }

  // 非管理員 → 完全靜默
  if (!admin) return;

  // ping
  if (/^ping$/i.test(cmd)) {
    const adminCount = String(env.ADMIN_USER_IDS || '').split(',').filter(Boolean).length;
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `🟢 pong\n管理員：${adminCount} 人\nuserId：${userId}\ngroupId：${groupId || '(私聊)'}` },
    ]);
    return;
  }

  if (!cmd) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '在的，有什麼事嗎？' }]);
    return;
  }

  // 短關鍵字 fast-path（不用跑 Gemini）
  const cmdShort = cmd.replace(/[?？!！。.\s]/g, '');
  let fast = null;
  if (/^(進度|目前|狀態|現況|收到幾筆|幾筆了)$/.test(cmdShort)) fast = { intent: 'progress' };
  else if (/^(結單|結束|關閉|收單|結束統計|結單吧|關閉統計)$/.test(cmdShort)) fast = { intent: 'close' };

  // ─── Gemini 意圖辨識（start_task / progress / close / chat）───
  const { intent, task_name: taskNameRaw, confidence } =
    fast ? { ...fast, confidence: 'high', task_name: null }
         : await geminiIntent(env.GEMINI_API_KEY, cmd);
  // confidence 不是 high 就當 chat 處理（避免誤判啟動任務）
  const doIt = confidence === 'high' || confidence === 'mid';

  if (doIt && intent === 'start_task') {
    const taskName = (taskNameRaw || '').trim();
    if (!taskName) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '要統計什麼主題？' }]);
      return;
    }
    if (!groupId) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '統計任務請在群組使用' }]);
      return;
    }
    const openTasks = await findOpenTasks(env.DB, groupId);
    const dup = openTasks.find(t => t.task_name === taskName);
    if (dup) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `「${taskName}」已經在進行中了` }]);
      return;
    }
    await createTask(env.DB, { groupId, taskName, startedBy: userId });
    const sibling = openTasks.length
      ? `\n(同時進行中：${openTasks.map(t => t.task_name).join('、')})` : '';
    const hint = confidence === 'mid' ? '\n(若不是這個意思，請再講清楚或「秘書 結單」取消)' : '';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `📝 開始統計「${taskName}」，請大家直接回覆${sibling}${hint}` },
    ]);
    return;
  }

  if (doIt && intent === 'progress' && groupId) {
    const tasks = await findOpenTasks(env.DB, groupId);
    if (!tasks.length) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '目前沒有進行中的任務' }]);
      return;
    }
    const hinted = taskNameRaw ? matchTaskByHint(tasks, taskNameRaw) : null;
    const picked = hinted || (tasks.length === 1 ? tasks[0] : null);
    if (!picked) {
      // 多任務且沒指名 → 全部摘要
      const blocks = [];
      for (const t of tasks) {
        const entries = await listEntries(env.DB, t.id);
        blocks.push(`📊「${t.task_name}」(${entries.length} 筆)\n${summarizeEntries(entries)}`);
      }
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: blocks.join('\n\n———\n\n') }]);
      return;
    }
    const entries = await listEntries(env.DB, picked.id);
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `📊 任務「${picked.task_name}」目前 ${entries.length} 筆\n\n${summarizeEntries(entries)}` },
    ]);
    return;
  }

  if (doIt && intent === 'close' && groupId) {
    const tasks = await findOpenTasks(env.DB, groupId);
    if (!tasks.length) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '目前沒有進行中的任務' }]);
      return;
    }
    const hinted = taskNameRaw ? matchTaskByHint(tasks, taskNameRaw) : null;
    const picked = hinted || (tasks.length === 1 ? tasks[0] : null);
    if (!picked) {
      const names = tasks.map(t => `「${t.task_name}」`).join('、');
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `目前有多個任務：${names}\n請說「秘書 結單 飲料」之類指定要結哪個` }]);
      return;
    }
    const entries = await listEntries(env.DB, picked.id);
    await closeTask(env.DB, picked.id);
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `✅ 任務「${picked.task_name}」已結單（共 ${entries.length} 筆）\n\n${summarizeEntries(entries)}` },
    ]);
    return;
  }

  // 秘書 裁定 <名字> 收/問/略（或口語）
  const verdict = cmd.match(/^裁定\s+(\S+)\s+(.+)$/);
  if (verdict && groupId) {
    const action = normalizeVerdict(verdict[2]);
    if (action) {
      await handleVerdict(env, groupId, verdict[1], action, replyToken);
      return;
    }
  }

  // ─── 其他一律閒聊 ───
  const reply = await geminiChat(env.GEMINI_API_KEY, cmd);
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

async function collectEntry(env, task, userId, text, replyToken) {
  // 讀該使用者目前已累積的資料，一起丟給 Gemini 合併判斷
  const existing = await env.DB.prepare(
    `SELECT data_json, note, price FROM entries WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  const known = existing ? {
    ...JSON.parse(existing.data_json || '{}'),
    ...(existing.note ? { 備註: existing.note } : {}),
    ...(existing.price ? { 價格: existing.price } : {}),
  } : {};

  const parsed = await geminiExtract(env.GEMINI_API_KEY, task.task_name, text, known);
  if (parsed?._error) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `[debug extract 失敗] ${parsed._error}` },
    ]);
    return;
  }
  if (parsed?.nonsense) {
    await handleNonsense(env, task, userId, text, replyToken, parsed.follow_up);
    return;
  }
  if (!parsed || !parsed.data || Object.keys(parsed.data).length === 0) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `[debug] 抽不到東西。parsed=${JSON.stringify(parsed).slice(0, 300)}` },
    ]);
    return;
  }
  await upsertEntry(env.DB, {
    taskId: task.id,
    userId,
    data: parsed.data,
    note: parsed.note,
    price: parsed.price,
    rawText: text,
  });

  const parts = Object.values(parsed.data).filter(Boolean).join('/');
  const price = parsed.price ? ` $${parsed.price}` : '';
  const note = parsed.note ? `（${parsed.note}）` : '';
  const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
  const followUp = parsed.follow_up || '';

  const m = await env.DB.prepare(
    `SELECT real_name, line_display FROM members WHERE user_id = ?`
  ).bind(userId).first();
  const name = (m?.real_name || m?.line_display || userId.slice(0, 6));

  let reply = `${name} ${parts}${price}${note}`;
  if (missing.length && followUp) {
    reply += `\n${followUp}`;
  }
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

function normalizeVerdict(s) {
  const t = String(s).trim().toUpperCase().replace(/[\s!?！？。.]+/g, '');
  if (/^(收|OK|可以|好|照記|照寫|記下|記|收下|就這樣|照舊)/.test(t)) return '收';
  if (/^(問|再問|重問|再一次|重來|AGAIN|RETRY|問他|問一下|叫他|叫他講|請他)/.test(t)) return '問';
  if (/^(略|略過|跳過|跳|忽略|算了|不要|不用管|不管|別管|別理|不理)/.test(t)) return '略';
  if (/(不吃|沒吃|不來|別吃|他不|不點|不用了|不用吃)/.test(t)) return '略';
  return null;
}

async function handleVerdict(env, groupId, nameHint, action, replyToken) {
  // 找該群組目前有 pending nonsense 的使用者（以名字/暱稱前綴比對）
  const pending = await env.DB.prepare(
    `SELECT n.task_id, n.user_id, n.last_text, m.real_name, m.line_display, t.task_name
       FROM nonsense_strikes n
       JOIN tasks t ON t.id = n.task_id
       LEFT JOIN members m ON m.user_id = n.user_id
      WHERE t.group_id = ? AND t.status = 'open' AND n.count >= 2
      ORDER BY n.last_at DESC`
  ).bind(groupId).all();
  const list = pending.results || [];
  const hit = list.find(r => {
    const n = r.real_name || r.line_display || '';
    return n.startsWith(nameHint) || n.includes(nameHint);
  });
  if (!hit) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `找不到待裁定的「${nameHint}」` }]);
    return;
  }
  const who = hit.real_name || hit.line_display || hit.user_id.slice(0, 6);

  if (action === '收') {
    // 照字面收：把 last_text 當一次正常的 extract 輸入，強制記下
    const known = {}; // 忽略 known，直接以這次文字為主
    const parsed = await geminiExtract(env.GEMINI_API_KEY, hit.task_name, hit.last_text, known);
    const data = (parsed && parsed.data && Object.keys(parsed.data).length) ? parsed.data : { 品項: hit.last_text };
    await upsertEntry(env.DB, {
      taskId: hit.task_id, userId: hit.user_id,
      data, note: (parsed?.note || null), price: (parsed?.price || null), rawText: hit.last_text,
    });
    await env.DB.prepare(`DELETE FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`).bind(hit.task_id, hit.user_id).run();
    const parts = Object.values(data).filter(Boolean).join('/');
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `✓ ${who} ${parts}（管理員裁定收下）` }]);
    return;
  }
  if (action === '問') {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `${who}，認真講一下要什麼～` }]);
    // 不清除 strikes，等他重答
    return;
  }
  if (action === '略') {
    // 記為「不吃」
    await upsertEntry(env.DB, {
      taskId: hit.task_id, userId: hit.user_id,
      data: {}, note: '不吃', price: null, rawText: hit.last_text,
    });
    await env.DB.prepare(`DELETE FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`).bind(hit.task_id, hit.user_id).run();
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `✓ ${who}：不吃（管理員裁定略過）` }]);
    return;
  }
}

async function handleNonsense(env, task, userId, text, replyToken, teaseFromAI) {
  const row = await env.DB.prepare(
    `SELECT count FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  const count = (row?.count || 0) + 1;
  await env.DB.prepare(
    `INSERT INTO nonsense_strikes (task_id, user_id, count, last_text, last_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       count = excluded.count, last_text = excluded.last_text, last_at = datetime('now')`
  ).bind(task.id, userId, count, text).run();

  const m = await env.DB.prepare(
    `SELECT real_name, line_display FROM members WHERE user_id = ?`
  ).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);

  if (count === 1) {
    const tease = teaseFromAI || '別鬧啦，認真講～';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: tease }]);
    return;
  }

  // 第 2 次以上 → 社交壓力版，@ 管理員裁定
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const adminNames = [];
  for (const aid of adminIds) {
    const a = await env.DB.prepare(
      `SELECT real_name, line_display FROM members WHERE user_id = ?`
    ).bind(aid).first();
    const nm = a?.real_name || a?.line_display;
    if (nm) adminNames.push(nm);
  }
  const adminTag = adminNames.length ? adminNames.map(n => `@${n}`).join(' ') + ' ' : '';
  const reply = `${adminTag}${who} 最後一次點了「${text}」，確定要幫他點這個嗎？\n回「秘書 裁定 ${who} 收/問/略」決定`;
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

async function upsertMemberSighting(DB, userId, groupId, token) {
  if (!DB) return;
  try {
    let display = null, avatar = null;
    if (groupId) {
      const p = await getGroupMemberProfile(token, groupId, userId);
      if (p) { display = p.displayName; avatar = p.pictureUrl; }
    } else {
      const p = await getUserProfile(token, userId);
      if (p) { display = p.displayName; avatar = p.pictureUrl; }
    }
    await DB.prepare(
      `INSERT INTO members (user_id, line_display, line_avatar, last_seen_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         line_display = COALESCE(excluded.line_display, line_display),
         line_avatar  = COALESCE(excluded.line_avatar, line_avatar),
         last_seen_at = datetime('now')`
    ).bind(userId, display, avatar).run();
  } catch (e) {
    console.error('[upsert member] fail:', e);
  }
}
