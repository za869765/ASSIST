// 共用函式：LINE 簽章驗證 / reply / push / profile

// bug #18: signature 比較須 constant-time，避免時間側通道。
function _ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // 在 length 不同時仍跑完一輪 XOR，避免提早 return 漏資訊
  const la = a.length, lb = b.length;
  const len = Math.max(la, lb);
  let diff = la ^ lb;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i % la || 1) ^ b.charCodeAt(i % lb || 1));
  }
  return diff === 0 && la === lb;
}

export async function verifyLineSignature(secret, body, signature) {
  if (!secret || !signature) return false;
  // 強制 body 必須是字串（避免 undefined/object 算空字串簽章）
  if (typeof body !== 'string') return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return _ctEqual(b64, String(signature));
}

export async function lineReply(token, replyToken, messages) {
  const arr = Array.isArray(messages) ? messages : [{ type: 'text', text: String(messages) }];
  // 特殊標記 "push:<to>"：改走 push API（用在多段切分、一次處理多筆回覆）
  if (typeof replyToken === 'string' && replyToken.startsWith('push:')) {
    const to = replyToken.slice(5);
    return linePush(token, to, arr);
  }
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

// bug #1/#3/#4: 給對外 HTTP API 用的 admin gate（不同於 LINE userId 白名單）。
// 透過 X-Admin-Pass header 傳遞，比對 ADMIN_PASS env var；兩者都缺直接 deny。
export function requireAdminPass(request, env) {
  const expected = String(env.ADMIN_PASS || '').trim();
  if (!expected) return false; // 沒設 secret 一律拒絕，避免 misconfig 變成裸奔
  const got = String(request.headers.get('X-Admin-Pass') || '').trim();
  if (!got) return false;
  // constant-time
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
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
