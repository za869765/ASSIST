// 全域分區設定：讀取 / 批次覆寫
import { requireAdminPass } from './line/_lib.js';

export async function onRequestGet({ env }) {
  const row = await env.DB.prepare(
    `SELECT name, capacity, enabled, sort_order FROM zones ORDER BY sort_order ASC, name ASC`
  ).all();
  return Response.json({ zones: row.results || [] });
}

export async function onRequestPost({ request, env }) {
  // bug #3: 原本無 auth，且先 DELETE 全表再 INSERT，{zones:[]} 即可清空。
  // 加 admin pass 驗證；改 upsert + 軟刪除（用 enabled=0 標記未列入的 zone），不再硬刪。
  if (!requireAdminPass(request, env)) {
    return new Response('admin auth required', { status: 401 });
  }
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const zones = Array.isArray(body?.zones) ? body.zones : null;
  if (!zones || !zones.length) return new Response('zones required (non-empty)', { status: 400 });

  // 取現有 zones name 集合，未在 body 中的標 enabled=0（保留歷史 zone 引用，不直接刪掉）
  const existing = await env.DB.prepare(`SELECT name FROM zones`).all();
  const existingNames = new Set((existing.results || []).map(r => r.name));

  const stmts = [];
  const incomingNames = new Set();
  let i = 0;
  for (const z of zones) {
    const name = String(z.name || '').trim();
    if (!name) continue;
    incomingNames.add(name);
    const capacity = Number.isFinite(+z.capacity) ? Math.max(0, +z.capacity | 0) : 1;
    const enabled = z.enabled ? 1 : 0;
    const sort_order = Number.isFinite(+z.sort_order) ? (+z.sort_order | 0) : (i * 10);
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO zones (name, capacity, enabled, sort_order) VALUES (?, ?, ?, ?)`
    ).bind(name, capacity, enabled, sort_order));
    i++;
  }
  // 軟刪除：未入 body 的舊 zone 改 enabled=0
  for (const oldName of existingNames) {
    if (!incomingNames.has(oldName)) {
      stmts.push(env.DB.prepare(
        `UPDATE zones SET enabled = 0 WHERE name = ?`
      ).bind(oldName));
    }
  }
  await env.DB.batch(stmts);
  return Response.json({ ok: true, count: zones.length, softDeleted: existingNames.size - incomingNames.size });
}
