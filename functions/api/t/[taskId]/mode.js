// 看板切換 task.mode：menu (有菜單) / free (無菜單)
// 需 admin pass 防亂改；前端共用 adminFetch helper（首次 prompt 後存 sessionStorage）
import { requireAdminPass } from '../../line/_lib.js';

export async function onRequestPost({ params, request, env }) {
  if (!requireAdminPass(request, env)) {
    return new Response('admin auth required', { status: 401 });
  }
  const taskId = String(params.taskId || '');
  if (!taskId) return new Response('taskId required', { status: 400 });
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const mode = body?.mode === 'menu' ? 'menu' : 'free';
  const r = await env.DB.prepare(`UPDATE tasks SET mode = ? WHERE id = ?`).bind(mode, taskId).run();
  if (!r.meta?.changes) return new Response('task not found', { status: 404 });
  return Response.json({ ok: true, mode });
}
