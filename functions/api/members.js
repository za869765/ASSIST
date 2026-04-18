// 成員列表（含 LINE userId、姓名、目前區）— 需 ?uid=<admin>
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const uid = String(url.searchParams.get('uid') || '').trim();
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!uid || !adminIds.includes(uid)) return new Response('forbidden', { status: 403 });
  // 排除代點的 synthetic 成員（user_id 以 'zone:' 開頭）
  const row = await env.DB.prepare(
    `SELECT user_id, real_name, line_display, zone, last_seen_at
       FROM members
      WHERE user_id NOT LIKE 'zone:%'
      ORDER BY (zone IS NULL OR zone = '') DESC, zone ASC, last_seen_at DESC`
  ).all();
  return Response.json({ members: row.results || [] });
}
