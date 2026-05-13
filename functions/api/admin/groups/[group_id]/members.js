// 群組成員清單（從 entries JOIN tasks 反查曾在該群組訂過單的 user_id）
// GET /api/admin/groups/<group_id>/members
import { requireAdminPass } from '../../../line/_lib.js';

function deny() { return new Response('forbidden', { status: 403 }); }

export async function onRequestGet({ params, request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  const group_id = String(params.group_id || '');
  if (!group_id) return new Response('Bad group_id', { status: 400 });

  const row = await env.DB.prepare(`
    SELECT
      e.user_id,
      m.real_name,
      m.line_display,
      m.zone,
      COUNT(e.id) AS entry_count,
      MAX(e.updated_at) AS last_entry_at
    FROM entries e
    INNER JOIN tasks t ON t.id = e.task_id
    LEFT JOIN members m ON m.user_id = e.user_id
    WHERE t.group_id = ?
    GROUP BY e.user_id
    ORDER BY last_entry_at DESC
  `).bind(group_id).all();

  return Response.json({ group_id, members: row.results || [] });
}
