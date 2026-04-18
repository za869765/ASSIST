// GET /api/roster?zone=衛生局
// 回傳花名冊（real_name/title/zone），給看板 modal 挑人用
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const zone = url.searchParams.get('zone');
  try {
    const rows = zone
      ? await env.DB.prepare(
          `SELECT id, real_name, title, zone FROM roster WHERE zone = ? ORDER BY title, real_name`
        ).bind(zone).all()
      : await env.DB.prepare(
          `SELECT id, real_name, title, zone FROM roster ORDER BY zone, title, real_name`
        ).all();
    return json({ list: rows.results || [] });
  } catch (e) {
    // roster 表還沒建 → 回空清單
    if (String(e).includes('no such table')) return json({ list: [] });
    return json({ error: String(e) }, 500);
  }
}
