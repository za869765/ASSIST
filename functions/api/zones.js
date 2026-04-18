// 全域分區設定：讀取 / 批次覆寫（需 ?uid=<admin LINE userId>）
function checkAdmin(request, env) {
  const url = new URL(request.url);
  const uid = String(url.searchParams.get('uid') || '').trim();
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return uid && adminIds.includes(uid);
}
export async function onRequestGet({ request, env }) {
  if (!checkAdmin(request, env)) return new Response('forbidden', { status: 403 });
  const row = await env.DB.prepare(
    `SELECT name, capacity, enabled, sort_order FROM zones ORDER BY sort_order ASC, name ASC`
  ).all();
  return Response.json({ zones: row.results || [] });
}

export async function onRequestPost({ request, env }) {
  if (!checkAdmin(request, env)) return new Response('forbidden', { status: 403 });
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const zones = Array.isArray(body?.zones) ? body.zones : null;
  if (!zones) return new Response('zones required', { status: 400 });

  const stmts = [env.DB.prepare(`DELETE FROM zones`)];
  let i = 0;
  for (const z of zones) {
    const name = String(z.name || '').trim();
    if (!name) continue;
    const capacity = Number.isFinite(+z.capacity) ? Math.max(0, +z.capacity | 0) : 1;
    const enabled = z.enabled ? 1 : 0;
    const sort_order = Number.isFinite(+z.sort_order) ? (+z.sort_order | 0) : (i * 10);
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO zones (name, capacity, enabled, sort_order) VALUES (?, ?, ?, ?)`
    ).bind(name, capacity, enabled, sort_order));
    i++;
  }
  await env.DB.batch(stmts);
  return Response.json({ ok: true, count: zones.length });
}
