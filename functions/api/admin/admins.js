// 管理員白名單 CRUD（D1 admins 表 + env.ADMIN_USER_IDS read-only 顯示）
// 走 X-Admin-Pass header gate
import { requireAdminPass, loadDbAdmins } from '../line/_lib.js';

function deny() { return new Response('forbidden', { status: 403 }); }

// GET → { env: [userId...], db: [{user_id, note, created_at, created_by}], members: { userId: {real_name, line_display} } }
export async function onRequestGet({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();

  const envIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const dbRows = await env.DB.prepare(
    `SELECT user_id, note, created_at, created_by FROM admins ORDER BY created_at DESC`
  ).all();

  // 撈所有相關 userId 的 member 資料（顯示真名/暱稱）
  const allIds = Array.from(new Set([...envIds, ...(dbRows.results || []).map(r => r.user_id)]));
  const members = {};
  if (allIds.length) {
    const placeholders = allIds.map(() => '?').join(',');
    const m = await env.DB.prepare(
      `SELECT user_id, real_name, line_display, zone, last_seen_at FROM members WHERE user_id IN (${placeholders})`
    ).bind(...allIds).all();
    for (const row of (m.results || [])) members[row.user_id] = row;
  }

  return Response.json({
    env: envIds,
    db: dbRows.results || [],
    members,
  });
}

// POST { user_id, note } → 新增 D1 admin
export async function onRequestPost({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const user_id = String(body?.user_id || '').trim();
  const note = String(body?.note || '').trim() || null;
  if (!user_id) return new Response('user_id required', { status: 400 });
  if (!/^U[a-f0-9]{32}$/i.test(user_id)) {
    return new Response('user_id 格式錯誤（應為 U + 32 hex）', { status: 400 });
  }
  await env.DB.prepare(
    `INSERT INTO admins (user_id, note, created_at, created_by)
     VALUES (?, ?, datetime('now'), 'admin-ui')
     ON CONFLICT(user_id) DO UPDATE SET note = excluded.note`
  ).bind(user_id, note).run();
  return Response.json({ ok: true, user_id, note });
}

// DELETE { user_id } → 刪 D1 admin（env 的不可由此刪）
export async function onRequestDelete({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const user_id = String(body?.user_id || '').trim();
  if (!user_id) return new Response('user_id required', { status: 400 });
  const r = await env.DB.prepare(`DELETE FROM admins WHERE user_id = ?`).bind(user_id).run();
  return Response.json({ ok: true, changes: r.meta?.changes || 0 });
}
