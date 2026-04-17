// LINE Messaging API webhook 入口
// M1：收訊 + 簽章驗證 + 管理員白名單 + echo + userId 探詢
//
// 測試用途：
// - 任何人私訊或在群組 @ 小秘書 並說「TAQ 小秘書 我的ID」→ 小秘書回該人 userId（這是 M1 自助取得 userId 的方式）
// - 管理員說「TAQ 小秘書 ping」→ 回 pong + 當前環境摘要
// - 其他人說 TAQ 指令 → 一律忽略（M1 暫時用回「🔒 權限不足」提示，M2 之後完全靜默）
// - 非 TAQ 開頭訊息 → M1 暫不處理（之後 M3 任務模式才會收集）

import {
  verifyLineSignature, lineReply, isAdmin, isWakeword, stripWakeword,
  getGroupMemberProfile, getUserProfile,
} from './_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.text();
  const signature = request.headers.get('x-line-signature') || '';

  const valid = await verifyLineSignature(env.LINE_CHANNEL_SECRET, body, signature);
  if (!valid) {
    return new Response('invalid signature', { status: 401 });
  }

  const payload = JSON.parse(body);
  const events = payload.events || [];

  // LINE 要求 webhook 快速回 200，我們不阻塞
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

  // 記錄最新一次看到的人（名冊自動登錄 / 更新）
  if (userId) {
    await upsertMemberSighting(env.DB, userId, groupId, env.LINE_CHANNEL_ACCESS_TOKEN);
  }

  // M1：只處理 TAQ 開頭的訊息，其餘留給後續里程碑
  if (!isWakeword(text)) return;

  const cmd = stripWakeword(text);
  const admin = isAdmin(userId, env);

  // 自助查自己 userId（所有人可用，方便建立白名單）
  if (/^我的ID/i.test(cmd) || /我的\s*id/i.test(cmd) || /whoami/i.test(cmd)) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `您的 userId：\n${userId}\n\n請把這組字串給管理員加入白名單。` },
    ]);
    return;
  }

  // 非管理員下指令 → M1 先提示，M2 之後改為完全靜默
  if (!admin) {
    // 方便您測試權限；正式版會改成 return; 靜默
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: '🔒 此指令僅管理員可用' },
    ]);
    return;
  }

  // 管理員指令：ping（M1 測試用）
  if (/^ping$/i.test(cmd)) {
    const adminCount = String(env.ADMIN_USER_IDS || '').split(',').filter(Boolean).length;
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      {
        type: 'text',
        text: `🟢 pong\n管理員人數：${adminCount}\n您的 userId：${userId}\ngroupId：${groupId || '(私聊)'}\n環境：${env.ENV || 'production'}`,
      },
    ]);
    return;
  }

  // M1：其他指令暫時 echo，之後由 M2 Gemini 接手
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
    { type: 'text', text: `[M1 echo]\n收到指令：${cmd}\n(Gemini 意圖解析將於 M2 啟用)` },
  ]);
}

async function upsertMemberSighting(DB, userId, groupId, token) {
  if (!DB) return;
  try {
    // 取最新暱稱
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
