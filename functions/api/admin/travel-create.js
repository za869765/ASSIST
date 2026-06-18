// v1.0.64 後台直接建立「會員旅遊」任務（免走 LINE）。回 {id, slug}，前端導去 /t/<slug>?admin=1
import { requireAdminPass } from '../line/_lib.js';
import { createTask } from '../line/_tasks.js';

export async function onRequestPost({ request, env }) {
  if (!requireAdminPass(request, env)) return new Response('forbidden', { status: 403 });
  let body;
  try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
  const taskName = String(body.taskName || '').trim().slice(0, 40);
  if (!taskName) return Response.json({ error: '請填任務名稱' }, { status: 400 });
  const groupId = String(body.groupId || '').trim();   // 選填：綁 LINE 群可同步群報名
  let travelJson;
  if (body.travel_json) {
    travelJson = typeof body.travel_json === 'string' ? body.travel_json : JSON.stringify(body.travel_json);
  } else {
    travelJson = JSON.stringify({ tripType: 'two', tier: 30 });
  }

  const { id, slug } = await createTask(env.DB, { groupId, taskName, startedBy: 'admin' });
  // pricing_mode='travel' + travel_json（容錯：travel_json 欄位未 migrate 時退回只設 mode）
  try {
    await env.DB.prepare(`UPDATE tasks SET pricing_mode = 'travel', travel_json = ? WHERE id = ?`).bind(travelJson, id).run();
  } catch {
    await env.DB.prepare(`UPDATE tasks SET pricing_mode = 'travel' WHERE id = ?`).bind(id).run();
  }
  return Response.json({ ok: true, id, slug });
}
