// 清除某區的代點殘留 entries（user_id = 'zone:<區名>'）
// 用途：admin 把該區停用後，舊的「<區> 請假」代點 entry 還掛在進行中任務
//   GET  /api/zone-entry?zone=北區       → 預覽會刪掉幾筆（不執行）
//   POST /api/zone-entry  body { zone }  → 真的刪除（含進行中任務）

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const zone = String(url.searchParams.get('zone') || '').trim();
  if (!zone) return json({ error: 'zone required (?zone=北區)' }, 400);
  const uid = `zone:${zone}`;
  const rows = await env.DB.prepare(
    `SELECT e.task_id, t.task_name, e.note, e.data_json, e.updated_at
       FROM entries e LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.user_id = ?`
  ).bind(uid).all();
  return json({ user_id: uid, count: (rows.results || []).length, entries: rows.results || [] });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const zone = String(body?.zone || '').trim();
  if (!zone) return json({ error: 'zone required' }, 400);
  const uid = `zone:${zone}`;
  const r = await env.DB.prepare(`DELETE FROM entries WHERE user_id = ?`).bind(uid).run();
  return json({ ok: true, user_id: uid, deleted: r.meta?.changes || 0 });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const zone = String(url.searchParams.get('zone') || '').trim();
  if (!zone) return json({ error: 'zone required' }, 400);
  const uid = `zone:${zone}`;
  const r = await env.DB.prepare(`DELETE FROM entries WHERE user_id = ?`).bind(uid).run();
  return json({ ok: true, user_id: uid, deleted: r.meta?.changes || 0 });
}
