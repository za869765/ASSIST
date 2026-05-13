// per-group 成員設定 CRUD
//   GET    ?group_id=X       → 該群成員（合併 entries 反查 + group_members override + members 全域 fallback）
//   PATCH  { group_id, user_id, real_name?, zone? } → upsert group_members 該筆
//   DELETE { group_id, user_id }                     → 清掉 per-group override（回到全域 fallback）
import { requireAdminPass } from '../line/_lib.js';

function deny() { return new Response('forbidden', { status: 403 }); }

export async function onRequestGet({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  const url = new URL(request.url);
  const group_id = String(url.searchParams.get('group_id') || '').trim();
  if (!group_id) return new Response('group_id required', { status: 400 });

  // 該群所有曾出現過的 user：來源 = entries(該群 tasks) ∪ group_members 已記紀錄
  // 顯示時優先 gm 值，沒設則 fallback 全域 members
  const row = await env.DB.prepare(`
    WITH u AS (
      SELECT DISTINCT e.user_id
        FROM entries e
        INNER JOIN tasks t ON t.id = e.task_id
       WHERE t.group_id = ?
      UNION
      SELECT user_id FROM group_members WHERE group_id = ?
    )
    SELECT
      u.user_id,
      gm.real_name AS group_real_name,
      gm.zone      AS group_zone,
      m.real_name  AS global_real_name,
      m.zone       AS global_zone,
      m.line_display,
      m.line_avatar,
      (SELECT MAX(e.updated_at) FROM entries e
         INNER JOIN tasks t ON t.id = e.task_id
        WHERE t.group_id = ? AND e.user_id = u.user_id) AS last_entry_at,
      (SELECT COUNT(*) FROM entries e
         INNER JOIN tasks t ON t.id = e.task_id
        WHERE t.group_id = ? AND e.user_id = u.user_id) AS entry_count
    FROM u
    LEFT JOIN group_members gm ON gm.group_id = ? AND gm.user_id = u.user_id
    LEFT JOIN members m ON m.user_id = u.user_id
    ORDER BY last_entry_at DESC NULLS LAST, u.user_id ASC
  `).bind(group_id, group_id, group_id, group_id, group_id).all();

  return Response.json({ group_id, members: row.results || [] });
}

export async function onRequestPatch({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const group_id = String(body?.group_id || '').trim();
  const user_id  = String(body?.user_id  || '').trim();
  if (!group_id) return new Response('group_id required', { status: 400 });
  if (!user_id)  return new Response('user_id required',  { status: 400 });

  // 先確保該列存在（不存在則 insert 空殼），再 UPDATE 只動有送的欄位
  const cur = await env.DB.prepare(
    `SELECT real_name, zone FROM group_members WHERE group_id = ? AND user_id = ?`
  ).bind(group_id, user_id).first();

  let real_name = cur?.real_name ?? null;
  let zone      = cur?.zone      ?? null;
  if (Object.prototype.hasOwnProperty.call(body, 'real_name')) {
    const v = String(body.real_name ?? '').trim();
    real_name = v || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'zone')) {
    const v = String(body.zone ?? '').trim();
    zone = v || null;
  }

  await env.DB.prepare(
    `INSERT INTO group_members (group_id, user_id, real_name, zone, last_seen_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(group_id, user_id) DO UPDATE SET
       real_name = excluded.real_name,
       zone      = excluded.zone,
       last_seen_at = datetime('now')`
  ).bind(group_id, user_id, real_name, zone).run();

  return Response.json({ ok: true, group_id, user_id, real_name, zone });
}

export async function onRequestDelete({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const group_id = String(body?.group_id || '').trim();
  const user_id  = String(body?.user_id  || '').trim();
  if (!group_id) return new Response('group_id required', { status: 400 });
  if (!user_id)  return new Response('user_id required',  { status: 400 });

  const r = await env.DB.prepare(
    `DELETE FROM group_members WHERE group_id = ? AND user_id = ?`
  ).bind(group_id, user_id).run();
  return Response.json({ ok: true, group_id, user_id, changes: r.meta?.changes || 0 });
}
