// v1.0.36 看板計價設定：admin 模式在看板 UI 上改 pricing_mode / total_amount / member_subsidy
// 比照 ./mode.js 模式（前端 admin=1 控管，不走 X-Admin-Pass header）
const ALLOWED_MODES = ['free_bento', 'menu', 'shared', 'drink', 'travel'];

export async function onRequestPost({ params, request, env }) {
  const taskId = String(params.taskId || '');
  if (!taskId) return new Response('taskId required', { status: 400 });
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const updates = [];
  const binds = [];

  if (Object.prototype.hasOwnProperty.call(body, 'pricing_mode')) {
    const v = String(body.pricing_mode ?? '').trim();
    if (!ALLOWED_MODES.includes(v)) return new Response('bad pricing_mode', { status: 400 });
    updates.push('pricing_mode = ?');
    binds.push(v);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'total_amount')) {
    const v = body.total_amount;
    if (v == null || v === '') {
      updates.push('total_amount = ?');
      binds.push(null);
    } else {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) return new Response('bad total_amount', { status: 400 });
      updates.push('total_amount = ?');
      binds.push(n);
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'member_subsidy')) {
    const v = body.member_subsidy;
    if (v == null || v === '') {
      updates.push('member_subsidy = ?');
      binds.push(null);
    } else {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) return new Response('bad member_subsidy', { status: 400 });
      updates.push('member_subsidy = ?');
      binds.push(n);
    }
  }
  if (updates.length === 0) return new Response('nothing to update', { status: 400 });

  binds.push(taskId);
  const r = await env.DB.prepare(
    `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds).run();
  if (!r.meta?.changes) return new Response('task not found', { status: 404 });
  return Response.json({ ok: true });
}
