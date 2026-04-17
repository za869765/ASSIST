// 共用函式：LINE 簽章驗證 / reply / push / profile

export async function verifyLineSignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return b64 === signature;
}

export async function lineReply(token, replyToken, messages) {
  const arr = Array.isArray(messages) ? messages : [{ type: 'text', text: String(messages) }];
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ replyToken, messages: arr }),
  });
}

export async function linePush(token, to, messages) {
  const arr = Array.isArray(messages) ? messages : [{ type: 'text', text: String(messages) }];
  return fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ to, messages: arr }),
  });
}

export async function getGroupMemberProfile(token, groupId, userId) {
  const r = await fetch(
    `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!r.ok) return null;
  return r.json();
}

export async function getUserProfile(token, userId) {
  const r = await fetch(
    `https://api.line.me/v2/bot/profile/${userId}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!r.ok) return null;
  return r.json();
}

export function isAdmin(userId, env) {
  const list = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(userId);
}

// 喚醒詞：開頭出現「小秘書」或「秘書」即可
// 容忍前綴 @ / / / TAQ（LINE 官方帳號無法被真正 @mention，使用者手打 @ 或 TAQ 當文字）
// 範例：「小秘書 ping」「@小秘書 ping」「TAQ 小秘書 ping」「/秘書 ping」
export function isWakeword(text) {
  if (!text) return false;
  const t = String(text).trim().toUpperCase().replace(/\s+/g, '');
  return /^(@|\/|TAQ)?小?秘書/.test(t);
}

// 取出喚醒詞後的指令內容
export function stripWakeword(text) {
  return String(text).trim()
    .replace(/^(?:@|\/|TAQ)?\s*小?秘書\s*[:：,，]?\s*/i, '')
    .trim();
}
