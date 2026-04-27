// 成員列表（含 LINE userId、姓名、目前區）
import { requireAdminPass } from './line/_lib.js';

export async function onRequestGet({ env }) {
  // 排除代點的 synthetic 成員（user_id 以 'zone:' 開頭）
  const row = await env.DB.prepare(
    `SELECT user_id, real_name, line_display, zone, last_seen_at
       FROM members
      WHERE user_id NOT LIKE 'zone:%'
      ORDER BY (zone IS NULL OR zone = '') DESC, zone ASC, last_seen_at DESC`
  ).all();
  return Response.json({ members: row.results || [] });
}

// 刪除成員（清掉名單裡不在編制的閒雜帳號）
// 需 X-Admin-Pass header；同時清掉該成員在進行中任務的點餐紀錄，避免殘留
export async function onRequestDelete({ request, env }) {
  if (!requireAdminPass(request, env)) {
    return new Response('admin auth required', { status: 401 });
  }
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const user_id = String(body?.user_id || '').trim();
  if (!user_id) return new Response('user_id required', { status: 400 });
  if (user_id.startsWith('zone:')) {
    return new Response('代點 placeholder 不可直接刪除', { status: 400 });
  }

  // 同步清進行中任務的 entries，避免看板繼續顯示
  const delEntries = await env.DB.prepare(
    `DELETE FROM entries WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE status = 'open')`
  ).bind(user_id).run();
  const delMember = await env.DB.prepare(`DELETE FROM members WHERE user_id = ?`).bind(user_id).run();

  return Response.json({
    ok: true,
    user_id,
    removed_member: delMember.meta?.changes || 0,
    removed_entries: delEntries.meta?.changes || 0,
  });
}
