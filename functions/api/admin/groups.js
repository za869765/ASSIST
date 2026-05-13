// 群組設定 CRUD（D1 groups 表）+ 合併 tasks 看到過的 group_id
import { requireAdminPass } from '../line/_lib.js';

function deny() { return new Response('forbidden', { status: 403 }); }

// GET → { groups: [{group_id, alias, enabled, first_seen_at, last_active_at, task_total, open_count}] }
// 來源 = groups 表 ∪ tasks.group_id distinct（後者已知 bot 進過的群組）
export async function onRequestGet({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();

  // 合併兩邊：groups 表 + tasks 出現過的 group_id（tasks 多但沒備註的補進來）
  const rows = await env.DB.prepare(`
    WITH g AS (SELECT group_id, alias, enabled, first_seen_at, last_active_at FROM groups),
         t AS (
           SELECT group_id,
                  COUNT(*) AS task_total,
                  SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
                  MAX(started_at) AS last_task_at
             FROM tasks
            GROUP BY group_id
         )
    SELECT
      COALESCE(g.group_id, t.group_id) AS group_id,
      g.alias,
      COALESCE(g.enabled, 1) AS enabled,
      g.first_seen_at,
      COALESCE(g.last_active_at, t.last_task_at) AS last_active_at,
      COALESCE(t.task_total, 0) AS task_total,
      COALESCE(t.open_count, 0) AS open_count
    FROM g LEFT JOIN t ON g.group_id = t.group_id
    UNION
    SELECT
      t.group_id, NULL AS alias, 1 AS enabled, NULL AS first_seen_at,
      t.last_task_at AS last_active_at,
      t.task_total, t.open_count
    FROM t LEFT JOIN g ON t.group_id = g.group_id
    WHERE g.group_id IS NULL
    ORDER BY last_active_at DESC NULLS LAST, group_id ASC
  `).all();

  return Response.json({ groups: rows.results || [] });
}

// PATCH { group_id, alias?, enabled? } → 更新（不存在則 insert）
export async function onRequestPatch({ request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const group_id = String(body?.group_id || '').trim();
  if (!group_id) return new Response('group_id required', { status: 400 });

  const exist = await env.DB.prepare(`SELECT alias, enabled FROM groups WHERE group_id = ?`).bind(group_id).first();
  const alias = body?.alias !== undefined ? (String(body.alias).trim() || null) : (exist?.alias ?? null);
  const enabled = body?.enabled !== undefined ? (body.enabled ? 1 : 0) : (exist?.enabled ?? 1);

  await env.DB.prepare(
    `INSERT INTO groups (group_id, alias, enabled, first_seen_at, last_active_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(group_id) DO UPDATE SET alias = excluded.alias, enabled = excluded.enabled`
  ).bind(group_id, alias, enabled).run();

  return Response.json({ ok: true, group_id, alias, enabled });
}
