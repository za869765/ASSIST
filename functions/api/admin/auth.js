// 後台密碼驗證：POST { pass } → 回傳 ok 與否
// 前端登入後把 pass 存 localStorage，後續 X-Admin-Pass header 帶入
import { requireAdminPass } from '../line/_lib.js';

function ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const expected = String(env.ADMIN_PASS || '').trim();
  if (!expected) {
    return Response.json({ ok: false, reason: 'ADMIN_PASS env var 未設定' }, { status: 503 });
  }
  const got = String(body?.pass || '').trim();
  if (!got || !ctEqual(got, expected)) {
    return Response.json({ ok: false }, { status: 401 });
  }
  return Response.json({ ok: true });
}

// 給其他 admin API import 用：直接驗 X-Admin-Pass header
export function gate(request, env) {
  return requireAdminPass(request, env);
}
