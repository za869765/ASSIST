// LINE Messaging API webhook 入口
// M1：簽章驗證 + 管理員白名單 + ping / whoami
// M3：群組任務模式（開始/進度/結單 + Gemini 抽欄位 + 非管理員訊息收集）
// 閒聊：非 M1/M3 指令的「秘書 xxx」→ Gemini 日常回應

import {
  verifyLineSignature, lineReply, isAdmin, isWakeword, stripWakeword,
  getGroupMemberProfile, getUserProfile,
} from './_lib.js';
import { geminiChat, geminiExtract } from './_gemini.js';
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

  // ─── M3 任務指令（只在群組有效）───
  if (groupId) {
    // 開始統計 XX
    const mStart = cmd.match(/^(?:開始|開|開啟)\s*(?:統計)?\s*(.+)$/);
    if (mStart && /統計|^開/.test(cmd)) {
      const taskName = mStart[1].trim();
      if (taskName) {
        const existing = await findOpenTask(env.DB, groupId);
        if (existing) {
          await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
            { type: 'text', text: `⚠️ 已有進行中任務：${existing.task_name}\n先「秘書 結單」再開新的` },
          ]);
          return;
        }
        await createTask(env.DB, { groupId, taskName, startedBy: userId });
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
          { type: 'text', text: `📝 開始統計「${taskName}」\n請大家直接在群組回覆內容（品項/備註/價格）\n我會自動收集，「秘書 結單」時彙總` },
        ]);
        return;
      }
    }

    // 進度 / 目前
    if (/^(進度|目前|狀態)$/.test(cmd)) {
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

    // 結單 / 結束
    if (/^(結束|結單|關閉|收單)(統計)?$/.test(cmd)) {
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
  }

  // ─── 閒聊（Gemini 日常回應）───
  if (!cmd) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '在的，有什麼事嗎？' }]);
    return;
  }
  const reply = await geminiChat(env.GEMINI_API_KEY, cmd);
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

async function collectEntry(env, task, userId, text, replyToken) {
  const parsed = await geminiExtract(env.GEMINI_API_KEY, task.task_name, text);
  if (!parsed || !parsed.data || Object.keys(parsed.data).length === 0) {
    // 抽不到東西就不吵，靜默略過
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
  const parts = Object.values(parsed.data).filter(Boolean).join(' / ');
  const price = parsed.price ? ` $${parsed.price}` : '';
  const note = parsed.note ? `（${parsed.note}）` : '';
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
    { type: 'text', text: `✓ 已記錄：${parts}${price}${note}` },
  ]);
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
