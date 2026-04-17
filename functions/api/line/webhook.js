// LINE Messaging API webhook 入口
// M1：簽章驗證 + 管理員白名單 + ping / whoami
// M3：群組任務模式（開始/進度/結單 + Gemini 抽欄位 + 非管理員訊息收集）
// 閒聊：非 M1/M3 指令的「秘書 xxx」→ Gemini 日常回應

import {
  verifyLineSignature, lineReply, isAdmin, isWakeword, stripWakeword,
  getGroupMemberProfile, getUserProfile,
} from './_lib.js';
import { geminiChat, geminiExtract, geminiIntent } from './_gemini.js';
import {
  findOpenTask, createTask, closeTask, upsertEntry, listEntries, summarizeEntries,
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
    const task = await findOpenTask(env.DB, groupId);
    if (!task) return;
    await collectEntry(env, task, userId, text, replyToken);
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

  // ─── Gemini 意圖辨識（start_task / progress / close / chat）───
  const { intent, task_name: taskNameRaw, confidence } = await geminiIntent(env.GEMINI_API_KEY, cmd);
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
    const existing = await findOpenTask(env.DB, groupId);
    if (existing) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `已有進行中任務：${existing.task_name}` }]);
      return;
    }
    await createTask(env.DB, { groupId, taskName, startedBy: userId });
    const hint = confidence === 'mid' ? '\n(若不是這個意思，請再講清楚或「秘書 結單」取消)' : '';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `📝 開始統計「${taskName}」，請大家直接回覆${hint}` },
    ]);
    return;
  }

  if (doIt && intent === 'progress' && groupId) {
    const task = await findOpenTask(env.DB, groupId);
    if (!task) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '目前沒有進行中的任務' }]);
      return;
    }
    const entries = await listEntries(env.DB, task.id);
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `📊 任務「${task.task_name}」目前 ${entries.length} 筆\n\n${summarizeEntries(entries)}` },
    ]);
    return;
  }

  if (doIt && intent === 'close' && groupId) {
    const task = await findOpenTask(env.DB, groupId);
    if (!task) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '目前沒有進行中的任務' }]);
      return;
    }
    const entries = await listEntries(env.DB, task.id);
    await closeTask(env.DB, task.id);
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `✅ 任務「${task.task_name}」已結單（共 ${entries.length} 筆）\n\n${summarizeEntries(entries)}` },
    ]);
    return;
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
  if (!parsed || !parsed.data || Object.keys(parsed.data).length === 0) {
    return; // 抽不到東西就靜默
  }
  await upsertEntry(env.DB, {
    taskId: task.id,
    userId,
    data: parsed.data,
    note: parsed.note,
    price: parsed.price,
    rawText: text,
  });

  const parts = Object.values(parsed.data).filter(Boolean).join(' / ');
  const price = parsed.price ? ` $${parsed.price}` : '';
  const note = parsed.note ? `（${parsed.note}）` : '';
  const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
  const followUp = parsed.follow_up || '';

  let reply = `✓ 已記錄：${parts}${price}${note}`;
  if (missing.length && followUp) {
    reply += `\n${followUp}`;
  }
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
