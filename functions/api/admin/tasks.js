// 歷史任務查詢（後台）：列出最近的任務 + 對應的 exports token（重下載用）
import { requireAdminPass } from '../line/_lib.js';

function deny() { return new Response('forbidden', { status: 403 }); }

// GET ?limit=50&status=closed|open|all
// 回傳：{ tasks: [{id, group_id, group_alias, task_name, status, started_at, closed_at, entry_count, exports: [{token, filename, expires_at, download_count}]}] }
export async function onRequestGet({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const status = String(url.searchParams.get('status') || 'all');

  let whereSql = '';
  if (status === 'closed') whereSql = `WHERE t.status = 'closed'`;
  else if (status === 'open') whereSql = `WHERE t.status = 'open'`;

  const tasks = await env.DB.prepare(`
    SELECT
      t.id, t.group_id, g.alias AS group_alias,
      t.task_name, t.status, t.mode, t.url_slug,
      t.started_at, t.closed_at, t.started_by,
      (SELECT COUNT(*) FROM entries e WHERE e.task_id = t.id) AS entry_count
    FROM tasks t
    LEFT JOIN groups g ON g.group_id = t.group_id
    ${whereSql}
    ORDER BY COALESCE(t.closed_at, t.started_at) DESC
    LIMIT ?
  `).bind(limit).all();

  const taskList = tasks.results || [];
  const ids = taskList.map(t => t.id);
  const exportsByTask = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const ex = await env.DB.prepare(`
      SELECT token, task_id, filename, expires_at, download_count, created_at
      FROM exports WHERE task_id IN (${placeholders})
      ORDER BY created_at DESC
    `).bind(...ids).all();
    for (const r of (ex.results || [])) {
      (exportsByTask[r.task_id] ||= []).push(r);
    }
  }
  for (const t of taskList) t.exports = exportsByTask[t.id] || [];

  return Response.json({ tasks: taskList });
}
