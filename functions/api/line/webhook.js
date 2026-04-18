// LINE Messaging API webhook 入口
// M1：簽章驗證 + 管理員白名單 + ping / whoami
// M3：群組任務模式（開始/進度/結單 + Gemini 抽欄位 + 非管理員訊息收集）
// 閒聊：非 M1/M3 指令的「秘書 xxx」→ Gemini 日常回應

import {
  verifyLineSignature, lineReply, linePush, isAdmin, isWakeword, stripWakeword,
  getGroupMemberProfile, getUserProfile,
} from './_lib.js';
import { geminiChat, geminiExtract, geminiIntent, geminiClassifyTask } from './_gemini.js';
import { buildXLSX } from './_xlsx.js';
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

    // 管理員若處於「多任務結算等待選擇」狀態，這則訊息直接當作任務名稱
    if (admin) {
      // 清除 2 分鐘前的過期紀錄
      await env.DB.prepare(`DELETE FROM pending_close WHERE created_at < datetime('now','-2 minutes')`).run();
      const pc = await env.DB.prepare(
        `SELECT 1 FROM pending_close WHERE group_id = ? AND admin_id = ?`
      ).bind(groupId, userId).first();
      if (pc) {
        const hit = matchTaskByHint(tasks, text.trim());
        await env.DB.prepare(`DELETE FROM pending_close WHERE group_id = ? AND admin_id = ?`).bind(groupId, userId).run();
        if (hit) {
          await doCloseTask(env, hit, replyToken);
          return;
        }
        // 沒匹配 → 當作取消，繼續走正常流程
      }
    }

    // 管理員直接問「進度」等（不用喚醒詞）
    const progShort = String(text || '').replace(/[?？!！。.\s]/g, '');
    if (admin && /^(進度|目前|狀態|現況|收到幾筆|幾筆了)(.*)?$/.test(progShort)) {
      const hintText = progShort.replace(/^(進度|目前|狀態|現況|收到幾筆|幾筆了)/, '').trim();
      await doProgressReport(env, tasks, hintText, replyToken);
      return;
    }

    // 管理員直接講「結算 / 結單 / 收單」等（不用喚醒詞）→ 結單流程
    const closeShort = String(text || '').replace(/[?？!！。.\s]/g, '');
    if (admin && /^(結單|結算|結束|關閉|收單|結束統計|結單吧|關閉統計|收工|收了|打烊)(.*)?$/.test(closeShort)) {
      const hintText = closeShort.replace(/^(結單|結算|結束|關閉|收單|結束統計|結單吧|關閉統計|收工|收了|打烊)/, '').trim();
      const hinted = hintText ? matchTaskByHint(tasks, hintText) : null;
      const picked = hinted || (tasks.length === 1 ? tasks[0] : null);
      if (!picked) {
        const names = tasks.map(t => `「${t.task_name}」`).join('、');
        await env.DB.prepare(
          `INSERT INTO pending_close (group_id, admin_id, created_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(group_id, admin_id) DO UPDATE SET created_at = datetime('now')`
        ).bind(groupId, userId).run();
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text', text: `目前有多個任務：${names}\n要結算哪個?`,
        }]);
        return;
      }
      await doCloseTask(env, picked, replyToken);
      return;
    }

    let target = tasks[0];
    if (tasks.length > 1) {
      // 若此人正在任一任務中有 pending_dup 且訊息是加/改裁示 → 優先導向該任務
      let routed = false;
      const v = normalizeVerdict(text);
      if (v === '加' || v === '改') {
        const ids = tasks.map(t => t.id);
        const placeholders = ids.map(() => '?').join(',');
        const pendingTask = await env.DB.prepare(
          `SELECT task_id FROM pending_dups WHERE user_id = ? AND task_id IN (${placeholders}) LIMIT 1`
        ).bind(userId, ...ids).first();
        if (pendingTask) {
          target = tasks.find(t => t.id === pendingTask.task_id) || tasks[0];
          routed = true;
        }
      }
      if (!routed) {
        const names = tasks.map(t => t.task_name);
        const { task_name } = await geminiClassifyTask(env.GEMINI_API_KEY, names, text);
        const picked = (task_name ? matchTaskByHint(tasks, task_name) : null) || tasks[0];
        target = picked;
      }
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
  else if (/^(結單|結算|結束|關閉|收單|結束統計|結單吧|關閉統計|收工|收了|打烊)$/.test(cmdShort)) fast = { intent: 'close' };

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
      const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
      const url = `${base}/t/${dup.url_slug || dup.id}`;
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `「${taskName}」已經在進行中\n即時看板：${url}` }]);
      return;
    }
    const created = await createTask(env.DB, { groupId, taskName, startedBy: userId });
    const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
    const viewUrl = `${base}/t/${created.slug}`;
    const sibling = openTasks.length
      ? `\n(同時進行中：\n${openTasks.map(t => `・${t.task_name}：${base}/t/${t.url_slug || t.id}`).join('\n')})` : '';
    const hint = confidence === 'mid' ? '\n(若不是這個意思，請再講清楚或「秘書 結單」取消)' : '';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `📝 開始統計「${taskName}」，請大家直接回覆\n即時看板：${viewUrl}${sibling}${hint}` },
    ]);
    return;
  }

  if (doIt && intent === 'progress' && groupId) {
    const tasks = await findOpenTasks(env.DB, groupId);
    if (!tasks.length) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '目前沒有進行中的任務' }]);
      return;
    }
    await doProgressReport(env, tasks, taskNameRaw || '', replyToken);
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
      await env.DB.prepare(
        `INSERT INTO pending_close (group_id, admin_id, created_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(group_id, admin_id) DO UPDATE SET created_at = datetime('now')`
      ).bind(groupId, userId).run();
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `目前有多個任務：${names}\n要結算哪個?` }]);
      return;
    }
    await doCloseTask(env, picked, replyToken);
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

  // ─── 群組內無進行中任務 → 保持靜默（避免未開任務時亂答）
  if (groupId) {
    const openTasks = await findOpenTasks(env.DB, groupId);
    if (!openTasks.length) return;
  }

  // ─── 其他一律閒聊 ───
  const reply = await geminiChat(env.GEMINI_API_KEY, cmd);
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

async function doProgressReport(env, tasks, hintText, replyToken) {
  const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
  const hinted = hintText ? matchTaskByHint(tasks, hintText) : null;
  const picked = hinted || (tasks.length === 1 ? tasks[0] : null);
  if (!picked) {
    const blocks = [];
    for (const t of tasks) {
      const entries = await listEntries(env.DB, t.id);
      const url = `${base}/t/${t.url_slug || t.id}`;
      blocks.push(`📊「${t.task_name}」(${entries.length} 筆) ${url}\n${summarizeEntries(entries)}`);
    }
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: blocks.join('\n\n———\n\n') }]);
    return;
  }
  const entries = await listEntries(env.DB, picked.id);
  const url = `${base}/t/${picked.url_slug || picked.id}`;
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
    { type: 'text', text: `📊 任務「${picked.task_name}」目前 ${entries.length} 筆\n即時看板：${url}\n\n${summarizeEntries(entries)}` },
  ]);
}

async function doCloseTask(env, picked, replyToken) {
  // 結單前：未回應的 pending_dups 預設視為「更改」，全部套用
  const pendingRows = await env.DB.prepare(
    `SELECT user_id, new_text, new_data, new_note, new_price FROM pending_dups WHERE task_id = ?`
  ).bind(picked.id).all();
  for (const p of (pendingRows.results || [])) {
    await upsertEntry(env.DB, {
      taskId: picked.id, userId: p.user_id,
      data: JSON.parse(p.new_data || '{}'),
      note: p.new_note, price: p.new_price, rawText: p.new_text,
      additive: false,
    });
  }
  await env.DB.prepare(`DELETE FROM pending_dups WHERE task_id = ?`).bind(picked.id).run();
  await env.DB.prepare(`DELETE FROM pending_profanity WHERE task_id = ?`).bind(picked.id).run();

  const entries = await listEntries(env.DB, picked.id);
  await closeTask(env.DB, picked.id);

  const rows = buildSheetRows(picked.task_name, entries);
  const bytes = buildXLSX(picked.task_name.slice(0, 31) || 'sheet', rows);
  const token = genDownloadToken();
  const filename = `${picked.task_name}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // 下載 token：24 小時到期，可多人重複下載
  const expiresDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expiresISO = expiresDate.toISOString().replace('T', ' ').slice(0, 19);
  await env.DB.prepare(
    `INSERT INTO exports (token, task_id, filename, content_type, blob, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(token, picked.id, filename, contentType, bytes, expiresISO).run();

  const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
  const dlUrl = `${base}/d/${token}`;
  const aggText = buildAggregateText(picked.task_name, entries);
  const tpeExpire = new Date(expiresDate.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');

  // 未分區名單（提醒管理員）
  const unassigned = entries.filter(e => !e.zone).map(e => e.real_name || e.line_display || (e.user_id || '').slice(0, 6));
  const unassignedLine = unassigned.length
    ? `\n\n⚠️ 未分區（${unassigned.length} 人）：${unassigned.join('、')}\n→ /admin/zones 可手動分區`
    : '';

  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
    { type: 'text', text: `✅ 任務「${picked.task_name}」已結單\n\n${aggText}${unassignedLine}\n\n📎 完整明細下載：\n${dlUrl}\n⏰ 連結在 ${tpeExpire}（台北時間）前有效，可多人重複下載` },
  ]);
}

async function collectEntry(env, task, userId, text, replyToken) {
  // 管理員標「請假」：「新化請假」「北區不吃」→ 該區記 請假，不再追問
  const leave = await tryZoneLeave(env, userId, text);
  if (leave) {
    await upsertEntry(env.DB, {
      taskId: task.id, userId: leave.userId,
      data: {}, note: '請假', price: null, rawText: text, additive: false,
    });
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `📝 已登記「${leave.zoneName}」請假` },
    ]);
    return;
  }

  // 管理員代點：「幫南區點素食便當」「永康要一個排骨飯」等，把名字記成該區
  const proxy = await tryProxyZone(env, userId, text);
  if (proxy?.multi) {
    // 多區自動拆分：依每個區名在文字中的位置切成片段，各自當成該區的點餐內容
    const zones = proxy.multi;
    const positions = zones
      .map(z => ({ zone: z, start: text.indexOf(z), end: text.indexOf(z) + z.length }))
      .filter(p => p.start >= 0)
      .sort((a, b) => a.start - b.start);
    const stripLead = (s) => s.replace(/^[\s跟和與,，、；的,]+/, '').trim();
    const prefix = stripLead(text.slice(0, positions[0].start));
    const segments = positions.map((p, i) => {
      const nextStart = i + 1 < positions.length ? positions[i + 1].start : text.length;
      return stripLead(text.slice(p.end, nextStart));
    });
    // 選一段當 fallback（當某區片段太短 → 表示「各一個…」的共用語意，拿最長那段補上）
    const candidates = [prefix, ...segments].filter(s => s.length >= 2);
    const main = candidates.reduce((a, b) => (b.length > a.length ? b : a), '');
    const finalSegs = segments.map(s => (s.length >= 2 ? s : main));

    const replies = [];
    for (let i = 0; i < positions.length; i++) {
      const r = await processProxyOrder(env, task, positions[i].zone, finalSegs[i] || main || text);
      replies.push(r);
    }
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
      type: 'text', text: replies.join('\n'),
    }]);
    return;
  }
  if (proxy) {
    userId = proxy.userId;
    text = proxy.text;
  }

  // 若此人在此任務有待確認的 pending_dup，且這次訊息能辨識成「加/改」→ 直接處理
  const pending = await env.DB.prepare(
    `SELECT new_text, new_data, new_note, new_price FROM pending_dups WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  if (pending) {
    const v = normalizeVerdict(text);
    if (v === '加' || v === '改') {
      await applyDupDecision(env, task.id, userId, pending, v === '加', replyToken);
      return;
    }
  }

  const existing = await env.DB.prepare(
    `SELECT data_json, note, price FROM entries WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  const known = existing ? {
    ...JSON.parse(existing.data_json || '{}'),
    ...(existing.note ? { 備註: existing.note } : {}),
    ...(existing.price ? { 價格: existing.price } : {}),
  } : {};

  // 純確認詞（對/沒錯/OK/嗯/好）：若已有紀錄 → 直接靜默帶過（原記錄保留）
  if (existing && /^[\s]*(對|對阿|對啊|沒錯|是|是的|好|好的|OK|ok|嗯|Y|y)[\s!?！？。.~～]*$/.test(text)) {
    return;
  }
  // 純否認詞（不對/錯了）：計次，第 1 次引導重說，第 2 次以上 @ 管理員裁示
  if (existing && /^[\s]*(不對|錯了|不是|錯|不對啦)[\s!?！？。.~～]*$/.test(text)) {
    const row = await env.DB.prepare(
      `SELECT count FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`
    ).bind(task.id, userId).first();
    const cnt = (row?.count || 0) + 1;
    await env.DB.prepare(
      `INSERT INTO nonsense_strikes (task_id, user_id, count, last_text, last_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(task_id, user_id) DO UPDATE SET count = excluded.count, last_text = excluded.last_text, last_at = datetime('now')`
    ).bind(task.id, userId, cnt, text).run();

    const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
    const who = m?.real_name || m?.line_display || userId.slice(0, 6);
    const oldItem = Object.values(JSON.parse(existing.data_json || '{}')).filter(Boolean).join('/') || '(未辨識)';

    if (cnt >= 2) {
      const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
      const adminNames = [];
      for (const aid of adminIds) {
        const a = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(aid).first();
        const nm = a?.real_name || a?.line_display;
        if (nm) adminNames.push(nm);
      }
      const adminTag = adminNames.length ? adminNames.map(n => `@${n}`).join(' ') + ' ' : '';
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
        type: 'text',
        text: `${adminTag}${who} 已經反應兩次「不對」了，目前紀錄是「${oldItem}」，麻煩您協助問一下實際要點什麼，謝謝 🙏`,
      }]);
    } else {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `${who} 麻煩您再說清楚一點，謝謝您 🙏` }]);
    }
    return;
  }

  // 管理員裁示指令：放行/通過/清除 <姓名>
  if (await tryClearPendingProfanity(env, task, userId, text, replyToken)) return;

  // 若此用戶有污穢發言待裁示，後續任何訊息先提醒管理員，不處理點餐
  const pendingP = await env.DB.prepare(
    `SELECT count, last_text FROM pending_profanity WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  if (pendingP) {
    await handleProfanity(env, task, userId, text, replyToken);
    return;
  }

  // 硬規則：明顯污穢/體液/性暗示字眼直接 @ 管理員，不進 Gemini
  if (isProfane(text)) {
    await handleProfanity(env, task, userId, text, replyToken);
    return;
  }

  // 撈「品項不適用欄位」知識庫當 Gemini 提示
  const noFieldsRows = await env.DB.prepare(`SELECT item, field FROM item_no_fields`).all();
  const itemNoFields = {};
  for (const r of (noFieldsRows.results || [])) {
    if (!itemNoFields[r.item]) itemNoFields[r.item] = [];
    itemNoFields[r.item].push(r.field);
  }
  const parsed = await geminiExtract(env.GEMINI_API_KEY, task.task_name, text, known, itemNoFields);
  if (parsed?._error) {
    console.error('[extract error]', parsed._error);
    return; // 靜默，不打擾群組
  }
  if (parsed?.profanity) {
    await handleProfanity(env, task, userId, text, replyToken);
    return;
  }
  // 便當類 + 只給葷/素 → 自動補全品項（比照 +1 行為）
  if (parsed?.data) {
    const taskIsBento = /便當|飯|自助餐|餐盒/.test(task.task_name || '');
    if (taskIsBento && !parsed.data['品項']) {
      const hs = parsed.data['葷素'];
      if (hs === '葷') parsed.data['品項'] = '葷食便當';
      else if (hs === '素') parsed.data['品項'] = '素食便當';
      else if (/(^|[^一二三四五六七八九十百千])葷(?!素)/.test(text) && !/素/.test(text)) { parsed.data['品項'] = '葷食便當'; parsed.data['葷素'] = '葷'; }
      else if (/素(?!食便當|食)/.test(text) && !/葷/.test(text)) { parsed.data['品項'] = '素食便當'; parsed.data['葷素'] = '素'; }
    }
  }
  if (parsed?.nonsense) {
    await handleNonsense(env, task, userId, text, replyToken, parsed.follow_up, !!existing);
    return;
  }
  // 取消訂單（全部或指定某項）
  if (parsed?.cancel && existing) {
    const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
    const who = m?.real_name || m?.line_display || userId.slice(0, 6);
    const existingData = JSON.parse(existing.data_json || '{}');
    const itemStr = existingData['品項'] || '';
    const items = itemStr.split(/\s*\+\s*/).filter(Boolean);
    let target = (parsed.cancel_target || '').trim();
    // 若 Gemini 沒給 target，嘗試從訊息裡推斷（針對葷/素關鍵字）
    if (!target && items.length > 1) {
      if (/葷/.test(text) && !/素/.test(text)) target = '葷';
      else if (/素/.test(text) && !/葷/.test(text)) target = '素';
    }

    const norm = (s) => String(s).replace(/\s+/g, '').replace(/[的那個個份]+$/, '').toLowerCase();
    // 指定取消某項 且 有多項 → 只刪該項
    if (target && items.length > 1) {
      const t = norm(target);
      const matches = (it) => {
        const n = norm(it);
        if (!t || !n) return false;
        if (n.includes(t) || t.includes(n)) return true;
        if (t.length <= 2 && n.includes(t)) return true;
        return false;
      };
      const remaining = items.filter(it => !matches(it));
      if (remaining.length && remaining.length < items.length) {
        const cancelled = items.filter(it => !remaining.includes(it));
        const newData = { ...existingData, '品項': remaining.join(' + ') };
        // 若剩單品且 葷素 與剩下品項衝突，修正或清掉
        if (remaining.length === 1) {
          if (/葷食/.test(remaining[0])) newData['葷素'] = '葷';
          else if (/素食/.test(remaining[0])) newData['葷素'] = '素';
        }
        await env.DB.prepare(
          `UPDATE entries SET data_json = ?, price = NULL, updated_at = datetime('now') WHERE task_id = ? AND user_id = ?`
        ).bind(JSON.stringify(newData), task.id, userId).run();
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text', text: `✅ 已幫 ${who} 取消「${cancelled.join('、')}」，剩下「${remaining.join(' + ')}」`,
        }]);
        return;
      }
    }

    // 多項但找不到取消目標 → 請使用者明示，避免誤刪全部
    const explicitAll = /(都|全部|全|所有|整個|全都|所有的|通通|一起)(不要|取消|刪|不點|不吃|不喝)/.test(text) || /^(取消|不要|不點)(我)?(的)?$/.test(text.trim());
    if (items.length > 1 && !explicitAll) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
        type: 'text', text: `@${who} 您目前有「${items.join('、')}」，請問是要取消哪一個？要全部取消請說「都不要了」`,
      }]);
      return;
    }

    // 全部取消
    await env.DB.prepare(`DELETE FROM entries WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
    await env.DB.prepare(`DELETE FROM pending_dups WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
    const oldItem = Object.values(existingData).filter(Boolean).join('/') || '(未辨識)';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `✅ 已幫 ${who} 取消「${oldItem}」` }]);
    return;
  }
  if (!parsed || !parsed.data || Object.keys(parsed.data).length === 0) {
    // 抽不到東西 → 若 AI 有追問話術就回，否則靜默略過（避免閒聊被亂回）
    if (parsed?.follow_up) {
      const mInfo = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
      const askName = mInfo?.real_name || mInfo?.line_display || userId.slice(0, 6);
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `@${askName} ${parsed.follow_up}` }]);
    }
    return;
  }

  // 已點過再講話的處理：
  //   1. 完全相同 → 重複確認，不動
  //   2. 明確「加點」字眼（高信心）→ 自動累加
  //   3. 其他（包含 replace 高信心）→ 先反問當事人「是要改還是加？」，避免誤刪舊紀錄
  let additive = false;
  let oldItemForReport = '';
  if (existing) {
    const oldData = JSON.parse(existing.data_json || '{}');
    const sameData = JSON.stringify(oldData) === JSON.stringify(parsed.data || {})
      && (existing.note || null) === (parsed.note || null)
      && (existing.price || null) === (parsed.price ?? null);
    if (sameData) {
      const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
      const who = m?.real_name || m?.line_display || userId.slice(0, 6);
      const parts = Object.values(oldData).filter(Boolean).join('/');
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `${who} 您已經點過「${parts}」了，記錄維持原樣～` }]);
      return;
    }
    const intent = parsed.dup_intent;
    const conf = typeof parsed.dup_confidence === 'number' ? parsed.dup_confidence : 0;
    // 訊息含明確改/換字眼 → 直接改（不用兩階段）
    const hasReplaceWord = /(^|[\s，,。、])?(改|換|更改|改成|改為|換成|換為|修改|取代|替換)/.test(text);
    const hasAddWord = /(^|[\s，,。、])(加|加點|加上|再加|再來|多加|多點|還要|外加|追加|併|合併)/.test(text);
    if (hasReplaceWord && !hasAddWord) {
      additive = false; // 直接改
    } else if (hasAddWord && !hasReplaceWord) {
      additive = true;
    } else if (intent === 'add' && conf >= 80) {
      additive = true; // 明確加點字眼才自動累加
    } else {
      // 其他一律反問當事人是改還是加，避免把舊的吃掉
      await askAddOrReplace(env, task, userId, text, parsed, oldData, replyToken);
      return;
    }
  }

  await upsertEntry(env.DB, {
    taskId: task.id,
    userId,
    data: parsed.data,
    note: parsed.note,
    price: parsed.price,
    rawText: text,
    additive,
  });
  // 成功收單 → 清零否認/亂點計數
  await env.DB.prepare(`DELETE FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
  // 學習：若使用者填了「不適用」欄位，記到 item_no_fields（品項層級，跨任務保留）
  await learnNoFields(env.DB, parsed.data);

  const parts = Object.values(parsed.data).filter(Boolean).join('/');
  const price = parsed.price ? ` $${parsed.price}` : '';
  const note = parsed.note ? `（${parsed.note}）` : '';
  // 過濾 missing：若 data 已含該欄位（或同義詞），就不算缺
  const dataKeys = new Set(Object.keys(parsed.data || {}));
  const synonyms = { '甜度': ['糖度'], '冰塊': ['冰量', '冰度'], '份量': ['大小', '飯量'] };
  const hasField = (k) => dataKeys.has(k) || (synonyms[k] || []).some(s => dataKeys.has(s));
  // 被動欄位黑名單：預設不主動追問（除非 AI 很堅持且 data 已有）
  const PASSIVE_FIELDS = new Set(['份量', '飯量', '大小', '葷素', '辣度', '備註', '忌口']);
  const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
    .filter(k => !hasField(k))
    .filter(k => !PASSIVE_FIELDS.has(k));
  const followUp = missing.length ? (parsed.follow_up || '') : '';

  const m = await env.DB.prepare(
    `SELECT real_name, line_display FROM members WHERE user_id = ?`
  ).bind(userId).first();
  const name = (m?.real_name || m?.line_display || userId.slice(0, 6));

  // 是否明確改/換字眼 → 肯定句收尾
  const explicitReplace = /(^|[\s，,。、])?(改|換|更改|改成|改為|換成|換為|修改|取代|替換)/.test(text);
  const explicitAdd = /(^|[\s，,。、])?(加|加點|加上|再加|再來|多加|多點|還要|外加|追加)/.test(text);
  // 品項能代表葷素時，就省略「葷素」欄位避免重複
  const dataForShow = { ...parsed.data };
  if (dataForShow['品項'] && /葷食|素食/.test(dataForShow['品項'])) delete dataForShow['葷素'];
  const showParts = Object.values(dataForShow).filter(Boolean).join('/');
  let reply;
  if (existing && additive && explicitAdd) {
    reply = `✅ 已幫 ${name} 加點 ${showParts}${price}${note}`;
  } else if (existing && additive) {
    reply = `${name} 加點 ${showParts}${price}${note}，是這樣嗎？`;
  } else if (existing && !additive && explicitReplace) {
    reply = `✅ 已幫 ${name} 換成 ${showParts}${price}${note}`;
  } else if (existing && !additive) {
    const tail = oldItemForReport ? `（原「${oldItemForReport}」已取消）` : '';
    reply = `${name} 改為 ${parts}${price}${note}${tail}，是這樣嗎？`;
  } else {
    reply = `${name} ${parts}${price}${note}`;
  }
  if (missing.length && followUp) {
    reply += `\n@${name} ${followUp}`;
  }
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

// 學習「品項沒有這個欄位」的規則，跨任務持久保留
async function learnNoFields(DB, data) {
  if (!data || typeof data !== 'object') return;
  const item = data['品項'];
  if (!item) return;
  for (const [k, v] of Object.entries(data)) {
    if (k === '品項') continue;
    if (typeof v === 'string' && /^(不適用|無|沒有|N\/A|無此選項)$/i.test(v.trim())) {
      try {
        await DB.prepare(`INSERT OR IGNORE INTO item_no_fields (item, field) VALUES (?, ?)`).bind(item, k).run();
      } catch (e) { console.error('[learnNoFields]', e); }
    }
  }
}

function genDownloadToken() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// 把 entries 正規化成 {name, item, data(其他欄位), note, price} 陣列
function normalizeParsed(entries) {
  return entries.map(e => {
    let data = {};
    try { data = JSON.parse(e.data_json || '{}'); } catch {}
    const name = e.real_name || e.line_display || (e.user_id ? e.user_id.slice(0, 6) : '');
    const item = data['品項'] || '';
    const rest = { ...data }; delete rest['品項'];
    return { name, item, data, rest, note: e.note || '', price: e.price, updated: e.updated_at, zone: e.zone || '' };
  });
}

// 產生多段 XLSX rows：① 訂購彙總（對店家）② 明細（依品項排序，發餐用）
function buildSheetRows(taskName, entries) {
  const parsed = normalizeParsed(entries);

  // 彙總：品項 → 份數、備註(含人名)、小計
  const groups = {};
  parsed.forEach(p => {
    const key = p.item || '(未辨識)';
    if (!groups[key]) groups[key] = { count: 0, notes: [], total: 0, people: [] };
    const g = groups[key];
    g.count += 1;
    g.total += p.price || 0;
    g.people.push(p.name);
    // 把備註與「非品項」欄位一起當修飾（方便店家看）
    const modParts = [];
    for (const k of Object.keys(p.rest)) {
      if (p.rest[k]) modParts.push(`${k}:${p.rest[k]}`);
    }
    if (p.note) modParts.push(p.note);
    if (modParts.length) g.notes.push(`${p.name}（${modParts.join('、')}）`);
  });

  const rows = [];
  rows.push([`任務：${taskName}　總筆數：${parsed.length}　匯出：${new Date().toISOString().replace('T', ' ').slice(0, 19)}`]);
  rows.push([]);

  // ① 訂購彙總
  rows.push(['■ 訂購彙總（對店家）']);
  rows.push(['品項', '份數', '備註 / 特殊要求', '小計']);
  let grandCount = 0, grandTotal = 0;
  Object.keys(groups)
    .sort((a, b) => groups[b].count - groups[a].count || a.localeCompare(b, 'zh-Hant'))
    .forEach(k => {
      const g = groups[k];
      rows.push([k, String(g.count), g.notes.join('；'), g.total ? String(g.total) : '']);
      grandCount += g.count;
      grandTotal += g.total;
    });
  rows.push(['合計', String(grandCount), '', grandTotal ? String(grandTotal) : '']);
  rows.push([]);

  // ② 明細：依品項排序（相同品項排一起），方便發餐
  const restFields = [];
  parsed.forEach(p => { for (const k of Object.keys(p.rest)) if (!restFields.includes(k)) restFields.push(k); });
  rows.push(['■ 明細（依品項排序，發餐用）']);
  rows.push(['品項', '姓名', '分組', ...restFields, '備註', '金額']);
  const sorted = [...parsed].sort((a, b) => {
    const ai = a.item || '~'; const bi = b.item || '~';
    if (ai !== bi) return ai.localeCompare(bi, 'zh-Hant');
    return a.name.localeCompare(b.name, 'zh-Hant');
  });
  sorted.forEach(p => {
    rows.push([
      p.item || '(未辨識)',
      p.name,
      p.zone || '(未分區)',
      ...restFields.map(k => p.rest[k] == null ? '' : String(p.rest[k])),
      p.note || '',
      p.price != null ? String(p.price) : '',
    ]);
  });

  return rows;
}

// 產生對店家的彙總文字（給 LINE 群組訊息）
function buildAggregateText(taskName, entries) {
  const parsed = normalizeParsed(entries);
  const groups = {};
  parsed.forEach(p => {
    const key = p.item || '(未辨識)';
    if (!groups[key]) groups[key] = { count: 0, total: 0 };
    groups[key].count += 1;
    groups[key].total += p.price || 0;
  });
  const lines = Object.keys(groups)
    .sort((a, b) => groups[b].count - groups[a].count || a.localeCompare(b, 'zh-Hant'))
    .map(k => {
      const g = groups[k];
      const price = g.total ? ` ＄${g.total}` : '';
      return `・${k} x${g.count}${price}`;
    });
  const totalCount = parsed.length;
  const totalPrice = parsed.reduce((s, p) => s + (p.price || 0), 0);
  const totalLine = `合計：${totalCount} 份${totalPrice ? `　＄${totalPrice}` : ''}`;
  return `📦「${taskName}」訂購彙總（對店家）\n${lines.join('\n')}\n\n${totalLine}`;
}

function normalizeVerdict(s) {
  const t = String(s).trim().toUpperCase().replace(/[\s!?！？。.]+/g, '');
  // 加點／累加（中文詞、英文詞含常見打錯字、符號）
  if (/^(\+|＋|加|加點|加上|加一|再加|再來|多加|多一|多點|多要|多來|累加|追加|一起|都要|還要|還需要|外加|併|合併|和|與)/.test(t)) return '加';
  if (/(再一(份|杯|個|碗|份兒))/.test(t)) return '加';
  if (/(多(一|兩|三)?(份|杯|個|碗))/.test(t)) return '加';
  // 英文：ADD / PLUS / AND / EXTRA / MORE / APPEND / ACCUM（含常見打錯字，只比對前幾碼）
  if (/^(AD+|PLU?S+|ANDD?|EXT|MOR|APP|ACCU?|APND|INCR)/.test(t)) return '加';
  // 改單／覆蓋
  if (/^(改|更改|改成|改為|改了|修改|換|換成|換為|重新|重點|取代|替換|覆蓋|不要剛剛|不要上面|以新|新的|以新為主)/.test(t)) return '改';
  if (/(取消前面|取消上面|取消剛剛|取消之前)/.test(t)) return '改';
  // 英文：REPLACE / CHANGE / MODIFY / EDIT / OVERWRITE / UPDATE（打錯字容錯）
  if (/^(REPL?|CHAN?G?|CHN?G?|MODI?|EDI?T?|OVER?W?|UPDT?|UPD|RWRT|CORR?)/.test(t)) return '改';
  if (/^(收|OK|可以|好|照記|照寫|記下|記|收下|就這樣|照舊)/.test(t)) return '收';
  if (/^(問|再問|重問|再一次|重來|AGAIN|RETRY|問他|問一下|叫他|叫他講|請他)/.test(t)) return '問';
  if (/^(略|略過|跳過|跳|忽略|算了|不要|不用管|不管|別管|別理|不理)/.test(t)) return '略';
  if (/(不吃|沒吃|不來|別吃|他不|不點|不用了|不用吃)/.test(t)) return '略';
  return null;
}

async function handleVerdict(env, groupId, nameHint, action, replyToken) {
  // 先找 pending_dups（加/改 場景）
  if (action === '加' || action === '改') {
    const dups = await env.DB.prepare(
      `SELECT p.task_id, p.user_id, p.new_text, p.new_data, p.new_note, p.new_price,
              m.real_name, m.line_display
         FROM pending_dups p
         JOIN tasks t ON t.id = p.task_id
         LEFT JOIN members m ON m.user_id = p.user_id
        WHERE t.group_id = ? AND t.status = 'open'
        ORDER BY p.created_at DESC`
    ).bind(groupId).all();
    const dlist = dups.results || [];
    const dhit = dlist.find(r => {
      const n = r.real_name || r.line_display || '';
      return n.startsWith(nameHint) || n.includes(nameHint);
    });
    if (dhit) {
      await applyDupDecision(env, dhit.task_id, dhit.user_id, {
        new_text: dhit.new_text, new_data: dhit.new_data, new_note: dhit.new_note, new_price: dhit.new_price,
      }, action === '加', replyToken);
      return;
    }
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `找不到待裁定的「${nameHint}」` }]);
    return;
  }

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

async function applyDupDecision(env, taskId, userId, pending, additive, replyToken) {
  // 改單先記舊品項（用於回報「原 X 取消」）
  let oldItem = '';
  if (!additive) {
    const oldRow = await env.DB.prepare(`SELECT data_json FROM entries WHERE task_id = ? AND user_id = ?`).bind(taskId, userId).first();
    oldItem = oldRow ? (Object.values(JSON.parse(oldRow.data_json || '{}')).filter(Boolean).join('/') || '') : '';
  }
  const data = JSON.parse(pending.new_data || '{}');
  await upsertEntry(env.DB, {
    taskId, userId,
    data,
    note: pending.new_note,
    price: pending.new_price,
    rawText: pending.new_text,
    additive,
  });
  await learnNoFields(env.DB, data);
  await env.DB.prepare(`DELETE FROM pending_dups WHERE task_id = ? AND user_id = ?`).bind(taskId, userId).run();
  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const row = await env.DB.prepare(`SELECT data_json, note, price FROM entries WHERE task_id = ? AND user_id = ?`).bind(taskId, userId).first();
  const finalData = JSON.parse(row?.data_json || '{}');
  const parts = Object.values(finalData).filter(Boolean).join('/');
  const price = row?.price ? ` $${row.price}` : '';
  const verb = additive ? '加點' : '改為';
  const tail = (!additive && oldItem) ? `（原「${oldItem}」已取消）` : '';

  // 檢查還缺什麼欄位（重新跑 AI 用最終資料當 known）
  const task = await env.DB.prepare(`SELECT task_name FROM tasks WHERE id = ?`).bind(taskId).first();
  let followUp = '';
  if (task?.task_name) {
    const known = { ...finalData, ...(row.note ? { 備註: row.note } : {}), ...(row.price ? { 價格: row.price } : {}) };
    const noFieldsRows = await env.DB.prepare(`SELECT item, field FROM item_no_fields`).all();
    const itemNoFields = {};
    for (const r of (noFieldsRows.results || [])) {
      if (!itemNoFields[r.item]) itemNoFields[r.item] = [];
      itemNoFields[r.item].push(r.field);
    }
    const check = await geminiExtract(env.GEMINI_API_KEY, task.task_name, pending.new_text || '', known, itemNoFields);
    const syn = { '甜度': ['糖度'], '冰塊': ['冰量', '冰度'], '份量': ['大小', '飯量'] };
    const finalKeys = new Set(Object.keys(finalData));
    const stillMissing = (Array.isArray(check?.missing) ? check.missing : [])
      .filter(k => !(finalKeys.has(k) || (syn[k] || []).some(s => finalKeys.has(s))));
    if (stillMissing.length) {
      const fu = check?.follow_up || `請問${stillMissing.join('、')}要什麼呢？`;
      followUp = `\n不過還差一點資訊～${fu}`;
    }
  }
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `✓ ${who} ${verb} ${parts}${price}${tail}${followUp}` }]);
}

// 反問當事人：要改還是再加一份
async function askAddOrReplace(env, task, userId, text, parsed, oldData, replyToken) {
  await env.DB.prepare(
    `INSERT INTO pending_dups (task_id, user_id, new_text, new_data, new_note, new_price, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       new_text = excluded.new_text, new_data = excluded.new_data,
       new_note = excluded.new_note, new_price = excluded.new_price,
       created_at = datetime('now')`
  ).bind(task.id, userId, text, JSON.stringify(parsed.data || {}), parsed.note || null, parsed.price ?? null).run();
  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const oldParts = Object.values(oldData).filter(Boolean).join('/');
  const newParts = Object.values(parsed.data || {}).filter(Boolean).join('/') || text;
  // 若 AI 有偵測到 missing 欄位，附上追問
  const dataKeys = new Set(Object.keys(parsed.data || {}));
  const syn = { '甜度': ['糖度'], '冰塊': ['冰量', '冰度'], '份量': ['大小', '飯量'] };
  const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
    .filter(k => !(dataKeys.has(k) || (syn[k] || []).some(s => dataKeys.has(s))));
  const followUp = (missing.length && parsed.follow_up) ? `\n另外，${parsed.follow_up}` : '';
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
    type: 'text',
    text: `${who} 您已經點了「${oldParts}」，剛剛的「${newParts}」，請問是要「更改」還是「加點」呢？\n請回覆，謝謝您 🙏${followUp}`,
  }]);
}

// 60~80%：反問當事人本人是否為 XXX（改單 / 加點）
async function askSelfConfirm(env, task, userId, text, parsed, intent, replyToken) {
  // 用 pending_dups 暫存本次解析結果，等他確認
  await env.DB.prepare(
    `INSERT INTO pending_dups (task_id, user_id, new_text, new_data, new_note, new_price, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       new_text = excluded.new_text, new_data = excluded.new_data,
       new_note = excluded.new_note, new_price = excluded.new_price,
       created_at = datetime('now')`
  ).bind(task.id, userId, text, JSON.stringify(parsed.data || {}), parsed.note || null, parsed.price ?? null).run();
  const parts = Object.values(parsed.data || {}).filter(Boolean).join('/') || text;
  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const verb = intent === 'add' ? '加點' : '改單';
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
    type: 'text',
    text: `${who} 想跟您確認一下，請問是要${verb}「${parts}」嗎？\n回「加」=加點、「改」=改單，謝謝您 🙏`,
  }]);
}

// <60%：問管理員裁定 加/改
async function handleDupPending(env, task, userId, text, parsed, replyToken) {
  await env.DB.prepare(
    `INSERT INTO pending_dups (task_id, user_id, new_text, new_data, new_note, new_price, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       new_text = excluded.new_text, new_data = excluded.new_data,
       new_note = excluded.new_note, new_price = excluded.new_price,
       created_at = datetime('now')`
  ).bind(task.id, userId, text, JSON.stringify(parsed.data || {}), parsed.note || null, parsed.price ?? null).run();

  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const oldRow = await env.DB.prepare(`SELECT data_json FROM entries WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).first();
  const oldItem = oldRow ? (JSON.parse(oldRow.data_json || '{}')['品項'] || '') : '';
  const newItem = Object.values(parsed.data || {}).filter(Boolean).join('/') || text;

  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const adminNames = [];
  for (const aid of adminIds) {
    const a = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(aid).first();
    const nm = a?.real_name || a?.line_display;
    if (nm) adminNames.push(nm);
  }
  const adminTag = adminNames.length ? adminNames.map(n => `@${n}`).join(' ') + ' ' : '';
  const reply = `${adminTag}打擾一下～${who} 原本點的是「${oldItem}」，剛剛又提到「${newItem}」，麻煩您裁示一下是要「加點」還是「改單」呢？謝謝 🙏`;
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

// 管理員標「請假」：偵測「新化請假」「北區不吃」「南區跳過」等
// 回傳 { userId: 'zone:<名>', zoneName } 或 null
async function tryZoneLeave(env, userId, text) {
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.includes(userId)) return null;

  const t = String(text || '').trim();
  const m = t.match(/^(.{1,8}?)(?:\s*)(請假|休假|不吃|沒訂|跳過|不訂|沒點)$/);
  if (!m) return null;

  const zoneHint = m[1].replace(/區$/, '');
  // 從 zones 表找：完全相符 或 含此關鍵字
  const zonesRow = await env.DB.prepare(
    `SELECT name FROM zones WHERE enabled = 1 ORDER BY length(name) DESC`
  ).all();
  const allZones = (zonesRow.results || []).map(r => r.name);
  let zoneName = allZones.find(n => n === m[1]) || allZones.find(n => n === m[1] + '區');
  if (!zoneName) zoneName = allZones.find(n => n.startsWith(zoneHint) || n.includes(zoneHint));
  if (!zoneName) return null;

  const synthId = `zone:${zoneName}`;
  await env.DB.prepare(
    `INSERT INTO members (user_id, real_name, zone, bound_at, last_seen_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET zone = excluded.zone, last_seen_at = datetime('now')`
  ).bind(synthId, zoneName, zoneName).run();
  return { userId: synthId, zoneName };
}

// 管理員代點：偵測「幫南區點素食便當」「衛生局要一個排骨飯」等
// 回傳 {userId, text} 或 null。userId 會被替換為 zone:<名稱>，text 則是移除代點用詞的點餐內容
async function tryProxyZone(env, userId, text) {
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.includes(userId)) return null;

  // 以 zones 表為單一來源（管理員在 /admin/zones 維護）
  const zonesRow = await env.DB.prepare(
    `SELECT name FROM zones WHERE enabled = 1`
  ).all();
  const enabledZones = (zonesRow.results || []).map(r => r.name).filter(Boolean);
  // 加上 zones 表沒列但已在 members 用過的（向下相容）
  const memZonesRow = await env.DB.prepare(
    `SELECT DISTINCT zone FROM members WHERE zone IS NOT NULL AND zone != ''`
  ).all();
  const memZones = (memZonesRow.results || []).map(r => r.zone).filter(Boolean);
  // 去「區」短別名也加入比對（「新化」要能匹到「新化區」）
  const aliases = enabledZones.flatMap(z => z.endsWith('區') ? [z, z.slice(0, -1)] : [z]);
  const all = [...new Set([...aliases, ...memZones])].sort((a, b) => b.length - a.length);

  const canonicalize = (name) =>
    enabledZones.find(n => n === name) ||
    enabledZones.find(n => n === name + '區') ||
    memZones.find(n => n === name) || null;

  // 多區偵測：文字中出現 ≥2 個合法區名 → 拆成多筆
  const foundCanon = [];
  for (const z of all) {
    const canon = canonicalize(z);
    if (!canon || foundCanon.includes(canon)) continue;
    if (text.includes(z)) foundCanon.push(canon);
  }
  if (foundCanon.length >= 2) {
    // 多區代點：不建 member row，回報給 caller 讓他提示使用者分開喊
    return { multi: foundCanon };
  }

  let zoneName = null;
  let stripped = text;

  // 模式 1：幫/替/代/把/為 + <任意名稱> + 點/要/... — 必須是合法區名
  const m1 = text.match(/(?:幫|替|代|把|為)\s*([^\s，,。\.]+?)(?=\s*(?:點|要|來|需要|一個|一份|一杯|一碗|想|吃|喝))/);
  if (m1) {
    const candidate = m1[1].trim();
    const canon = canonicalize(candidate);
    if (canon) {
      zoneName = canon;
      stripped = text.replace(m1[0], '').trim();
    }
  }
  if (!zoneName) {
    // 模式 2：直接出現已知名稱 + 點/要/的/一個
    for (const z of all) {
      const idx = text.indexOf(z);
      if (idx < 0) continue;
      const after = text.slice(idx + z.length);
      const before = text.slice(0, idx);
      if (/^\s*(?:點|要|來|需要|一個|一份|一杯|一碗|的)/.test(after)
          || /(?:幫|替|代|把|為)\s*$/.test(before)) {
        const canon = canonicalize(z);
        if (canon) {
          zoneName = canon;
          stripped = (before + after.replace(/^\s*(?:點|要|來|需要|的)/, '')).replace(/^(?:幫|替|代|把|為)\s*/, '').trim();
          break;
        }
      }
    }
  }

  if (!zoneName) return null;

  const targetId = await resolveZoneTargetId(env, zoneName);
  return { userId: targetId, text: stripped || text };
}

// 若該區已綁某位真人 → 直接用他的 LINE userId（視同本人回覆）；否則 fallback 用 zone:<名> 代點
async function resolveZoneTargetId(env, zoneName) {
  const real = await env.DB.prepare(
    `SELECT user_id FROM members
      WHERE zone = ? AND user_id NOT LIKE 'zone:%'
      ORDER BY last_seen_at DESC LIMIT 1`
  ).bind(zoneName).first();
  if (real?.user_id) return real.user_id;

  const synthId = `zone:${zoneName}`;
  await env.DB.prepare(
    `INSERT INTO members (user_id, real_name, zone, bound_at, last_seen_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at = datetime('now')`
  ).bind(synthId, zoneName, zoneName).run();
  return synthId;
}

// 多區代點用：直接處理單一區的一筆點餐（不走 replyToken，回傳一行確認字串）
async function processProxyOrder(env, task, zoneName, orderText) {
  const targetId = await resolveZoneTargetId(env, zoneName);

  const noFieldsRows = await env.DB.prepare(`SELECT item, field FROM item_no_fields`).all();
  const itemNoFields = {};
  for (const r of (noFieldsRows.results || [])) {
    if (!itemNoFields[r.item]) itemNoFields[r.item] = [];
    itemNoFields[r.item].push(r.field);
  }
  const parsed = await geminiExtract(env.GEMINI_API_KEY, task.task_name, orderText, {}, itemNoFields);
  if (!parsed || !parsed.data || Object.keys(parsed.data).length === 0) {
    return `⚠️ ${zoneName}：無法辨識「${orderText}」`;
  }
  await upsertEntry(env.DB, {
    taskId: task.id, userId: targetId,
    data: parsed.data, note: parsed.note, price: parsed.price,
    rawText: orderText, additive: false,
  });
  const parts = Object.values(parsed.data).filter(Boolean).join('/');
  const price = parsed.price ? ` $${parsed.price}` : '';
  const note = parsed.note ? `（${parsed.note}）` : '';
  return `✅ ${zoneName}：${parts}${price}${note}`;
}

// 硬規則污穢字偵測：體液/排泄物/性器官/中文粗話等
const PROFANITY_RE = /(尿液|尿尿|屎|大便|糞|屁股|精液|嘔吐|鼻屎|痰|月經|經血|陰道|陰莖|雞雞|屌|幹你|幹他|操你|肏|去死|靠北|靠腰|幹話|白癡|智障|低能|f[u\*]ck|shit|bitch|dick|pussy|asshole)/i;
function isProfane(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // 單字「尿」「屎」「糞」等單獨出現也算
  if (/^(尿|屎|糞|屁|痰)$/.test(s)) return true;
  return PROFANITY_RE.test(s);
}

async function handleProfanity(env, task, userId, text, replyToken) {
  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const adminNames = [];
  for (const aid of adminIds) {
    const a = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(aid).first();
    const nm = a?.real_name || a?.line_display;
    if (nm) adminNames.push(nm);
  }
  const adminTag = adminNames.length ? adminNames.map(n => `@${n}`).join(' ') + ' ' : '';

  // 記錄待裁示
  await env.DB.prepare(
    `INSERT INTO pending_profanity (task_id, user_id, last_text, count, last_at)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       last_text = excluded.last_text,
       count = pending_profanity.count + 1,
       last_at = datetime('now')`
  ).bind(task.id, userId, text).run();
  const row = await env.DB.prepare(
    `SELECT count FROM pending_profanity WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  const n = row?.count || 1;

  const msg = n === 1
    ? `${adminTag}${who} 似乎講了不太適合的字眼（「${text}」），麻煩您裁示一下，謝謝 🙏`
    : `${adminTag}${who} 又講了不太適合的字眼（「${text}」，累計 ${n} 次），還在等您裁示，麻煩您處理一下，謝謝 🙏`;
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: msg }]);
}

// 管理員下達：@小秘書 放行 <姓名>、@小秘書 通過 <姓名>、@小秘書 清除 <姓名>
// 或 admin 直接在群組說「放行兆鑫」「通過 兆鑫」等
async function tryClearPendingProfanity(env, task, senderUserId, text, replyToken) {
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.includes(senderUserId)) return false;
  const m = text.match(/(放行|通過|清除|放過)\s*@?\s*([\u4e00-\u9fa5A-Za-z0-9]+)/);
  if (!m) return false;
  const name = m[2];
  // 找出該名字對應的 user_id
  const target = await env.DB.prepare(
    `SELECT user_id, real_name, line_display FROM members WHERE real_name = ? OR line_display = ? LIMIT 1`
  ).bind(name, name).first();
  if (!target) return false;
  const r = await env.DB.prepare(
    `DELETE FROM pending_profanity WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, target.user_id).run();
  if ((r.meta?.changes || 0) > 0) {
    const who = target.real_name || target.line_display || name;
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
      type: 'text', text: `✅ 已清除 ${who} 的污穢發言待裁示紀錄，對方可以重新點餐。`,
    }]);
    return true;
  }
  return false;
}

async function handleNonsense(env, task, userId, text, replyToken, teaseFromAI, hasExisting) {
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

  // 未點狀態：模糊/矛盾比較正常，第 1 次 AI 吐槽留空間；第 2 次起才 @ 管理員
  // 已點狀態：已經有有效紀錄，任何矛盾發言直接 @ 管理員（不再吐槽浪費時間）
  if (!hasExisting && count === 1) {
    const tease = teaseFromAI || '您這個描述我沒辦法幫您點，麻煩再提供一次正確的品項，謝謝您 🙏';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: tease }]);
    return;
  }

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
  const context = hasExisting
    ? `${who} 已有紀錄，剛剛又講「${text}」，似乎在開玩笑或矛盾`
    : `${who} 最後一次點了「${text}」，內容不太合理`;
  const reply = `${adminTag}${context}，麻煩您協助裁示一下，謝謝 🙏`;
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
