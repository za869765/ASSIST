// 標記成員區：POST { user_id, zone }  zone 可為空字串 = 取消分區
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const user_id = String(body?.user_id || '').trim();
  const zone = String(body?.zone || '').trim(); // 空字串 = 清除
  if (!user_id) return new Response('user_id required', { status: 400 });

  // 若指定 zone，檢查是否存在於 zones 表（不限制也可以，但先驗證避免誤打）
  if (zone) {
    const hit = await env.DB.prepare(`SELECT 1 FROM zones WHERE name = ? AND enabled = 1`).bind(zone).first();
    if (!hit) return new Response(`zone "${zone}" not found or disabled`, { status: 400 });
  }

  // 若成員不存在，建立（代點用 zone:XXX 可能還沒 row）
  await env.DB.prepare(
    `INSERT INTO members (user_id, zone, last_seen_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET zone = excluded.zone, last_seen_at = datetime('now')`
  ).bind(user_id, zone || null).run();

  // 衝突合併：真人被拉到某區時，若該區在進行中任務有 zone:<區> 代點紀錄
  //   → 真人已有自己的 entry 在同任務 → 刪代點（真人優先）
  //   → 真人沒 entry → 把代點 entry user_id 改為真人（保留點餐內容）
  let merged = 0;
  if (zone && !user_id.startsWith('zone:')) {
    const proxyUid = `zone:${zone}`;
    const openTasksRow = await env.DB.prepare(
      `SELECT id FROM tasks WHERE status = 'open'`
    ).all();
    for (const t of (openTasksRow.results || [])) {
      const proxyEntry = await env.DB.prepare(
        `SELECT 1 FROM entries WHERE task_id = ? AND user_id = ?`
      ).bind(t.id, proxyUid).first();
      if (!proxyEntry) continue;
      const realEntry = await env.DB.prepare(
        `SELECT 1 FROM entries WHERE task_id = ? AND user_id = ?`
      ).bind(t.id, user_id).first();
      if (realEntry) {
        await env.DB.prepare(`DELETE FROM entries WHERE task_id = ? AND user_id = ?`).bind(t.id, proxyUid).run();
      } else {
        await env.DB.prepare(`UPDATE entries SET user_id = ? WHERE task_id = ? AND user_id = ?`).bind(user_id, t.id, proxyUid).run();
      }
      merged++;
    }
  }

  return Response.json({ ok: true, user_id, zone: zone || null, merged });
}
