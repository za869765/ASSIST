// v1.0.37 看板更新 entry.data 上的非會員旗標（合菜模式用）
// body: { user_id, guest_join?, guest_bento?, bento_type? }
// guest_join / guest_bento: boolean → 寫入 data.guest_join / data.guest_bento
// bento_type: '葷' | '素' → 寫入 data.bento_type
// 比照 ./mode.js / ./pricing.js pattern（前端 admin=1 控管，不走 X-Admin-Pass）
const BENTO_TYPES = ['葷', '素'];

export async function onRequestPost({ params, request, env }) {
  const taskId = String(params.taskId || '');
  if (!taskId) return new Response('taskId required', { status: 400 });
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const userId = String(body?.user_id || '').trim();
  if (!userId) return new Response('user_id required', { status: 400 });

  const row = await env.DB.prepare(
    `SELECT data_json FROM entries WHERE task_id = ? AND user_id = ?`
  ).bind(taskId, userId).first();
  if (!row) return new Response('entry not found', { status: 404 });

  let data = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch {}

  let touched = false;
  if (Object.prototype.hasOwnProperty.call(body, 'guest_join')) {
    data.guest_join = !!body.guest_join;
    touched = true;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'guest_bento')) {
    data.guest_bento = !!body.guest_bento;
    touched = true;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'bento_type')) {
    const v = String(body.bento_type ?? '').trim();
    if (v === '') {
      delete data.bento_type;
    } else if (!BENTO_TYPES.includes(v)) {
      return new Response('bad bento_type', { status: 400 });
    } else {
      data.bento_type = v;
    }
    touched = true;
  }
  if (!touched) return new Response('nothing to update', { status: 400 });

  await env.DB.prepare(
    `UPDATE entries SET data_json = ?, updated_at = datetime('now')
      WHERE task_id = ? AND user_id = ?`
  ).bind(JSON.stringify(data), taskId, userId).run();

  return Response.json({ ok: true, data });
}
