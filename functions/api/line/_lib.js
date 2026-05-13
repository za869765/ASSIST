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

// 從 D1 載入「線上新增」的管理員 userId（v1.0.27+ 後台管理用）
// 表未存在時回空陣列（向下相容，不破壞既有部署）
export async function loadDbAdmins(DB) {
  try {
    const r = await DB.prepare('SELECT user_id FROM admins').all();
    return (r.results || []).map(x => x.user_id);
  } catch {
    return [];
  }
}

// 取得「env CSV ∪ D1 admins」全集，給 webhook 統一比對
export function allAdminIds(env, dbAdmins = []) {
  const fromEnv = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return Array.from(new Set([...fromEnv, ...dbAdmins]));
}

// 向下相容：未傳 dbAdmins 時等同舊行為（只看 env）
export function isAdmin(userId, env, dbAdmins) {
  return allAdminIds(env, dbAdmins || []).includes(userId);
}

// 30 秒 TTL 快取：合併 env CSV ∪ D1 admins
// 在後台新增管理員後最慢 30 秒生效（webhook 不必重新部署）
let _adminCache = { ids: [], expiresAt: 0, envSig: '' };

export async function getAllAdminIdsCached(env, DB) {
  const now = Date.now();
  const envSig = String(env?.ADMIN_USER_IDS || '');
  if (now < _adminCache.expiresAt && _adminCache.envSig === envSig) {
    return _adminCache.ids;
  }
  const dbAdmins = await loadDbAdmins(DB);
  const all = allAdminIds(env, dbAdmins);
  _adminCache = { ids: all, expiresAt: now + 30_000, envSig };
  return all;
}

// 群組是否被後台停用（非管理員訊息一律 silent）
// 表未存在時視為啟用，避免新部署炸
export async function isGroupDisabled(DB, groupId) {
  if (!groupId) return false;
  try {
    const r = await DB.prepare('SELECT enabled FROM groups WHERE group_id = ?').bind(groupId).first();
    return r ? r.enabled === 0 : false;
  } catch {
    return false;
  }
}

// 記錄群組活動時間（首次出現自動 insert）
export async function touchGroup(DB, groupId) {
  if (!groupId) return;
  try {
    await DB.prepare(
      `INSERT INTO groups (group_id, enabled, first_seen_at, last_active_at)
       VALUES (?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(group_id) DO UPDATE SET last_active_at = datetime('now')`
    ).bind(groupId).run();
  } catch {}
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

// v1.0.34: per-group 姓名/分區查詢 — group_members 優先，fallback members 全域
//          (helper 暫供未來使用；webhook.js 內既有 26+ 處 SELECT real_name 暫不替換以縮限風險)
// 用法：const m = await getMemberDisplay(env.DB, groupId, userId);
//      回傳 { real_name, line_display, zone, line_avatar } 或 null
export async function getMemberDisplay(DB, groupId, userId) {
  if (!DB || !userId) return null;
  if (!groupId) {
    return await DB.prepare(
      `SELECT real_name, line_display, zone, line_avatar FROM members WHERE user_id = ?`
    ).bind(userId).first();
  }
  return await DB.prepare(`
    SELECT COALESCE(gm.real_name, m.real_name) AS real_name,
           m.line_display,
           m.line_avatar,
           COALESCE(gm.zone, m.zone) AS zone
      FROM members m
      LEFT JOIN group_members gm ON gm.group_id = ? AND gm.user_id = m.user_id
     WHERE m.user_id = ?
  `).bind(groupId, userId).first();
}
