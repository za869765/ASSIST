// 按 task 的 menu_json 重算所有 entries 的 price
// v1.0.44 修 menu OCR 抽 M 價導致 entries.price 殘留錯誤的問題
// POST /api/admin/tasks/<id>/reprice
//   - 比對 menu_json 中的品項名稱 → 取 price 覆寫 entries.price
//   - 不處理加料額外加價（加料金額目前不在 menu_json 中）
//   - 不修改沒 data.品項 的 entry、不修改菜單外的品項
import { requireAdminPass } from '../../../line/_lib.js';

function deny() { return new Response('forbidden', { status: 403 }); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ request, env, params }) {
  if (!requireAdminPass(request, env)) return deny();
  const id = parseInt(String(params.id || ''), 10);
  if (!id) return json({ error: 'bad id' }, 400);

  const task = await env.DB.prepare(`SELECT id, menu_json FROM tasks WHERE id = ?`).bind(id).first();
  if (!task) return json({ error: 'task not found' }, 404);
  if (!task.menu_json) return json({ error: '此任務沒有菜單，無法重算' }, 400);

  let menu;
  try { menu = JSON.parse(task.menu_json); } catch { return json({ error: 'menu_json 損毀' }, 500); }
  if (!Array.isArray(menu) || !menu.length) return json({ error: '菜單為空' }, 400);

  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const menuMap = new Map();
  for (const it of menu) {
    if (it.name && it.price != null) menuMap.set(norm(it.name), +it.price);
  }
  if (!menuMap.size) return json({ error: '菜單沒有任何含價格的品項' }, 400);

  const entries = await env.DB.prepare(
    `SELECT id, data_json, price FROM entries WHERE task_id = ?`
  ).bind(id).all();

  const details = [];
  let updated = 0;
  let unchanged = 0;
  let skippedNoItem = 0;
  let skippedNotInMenu = 0;

  for (const e of (entries.results || [])) {
    let data; try { data = JSON.parse(e.data_json || '{}'); } catch { data = {}; }
    const item = data['品項'];
    if (!item) { skippedNoItem++; continue; }
    const menuPrice = menuMap.get(norm(item));
    if (menuPrice == null) {
      skippedNotInMenu++;
      details.push({ id: e.id, item, old: e.price, new: null, reason: 'not in menu' });
      continue;
    }
    if (+menuPrice === +e.price) { unchanged++; continue; }
    await env.DB.prepare(`UPDATE entries SET price = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(menuPrice, e.id).run();
    updated++;
    details.push({ id: e.id, item, old: e.price, new: menuPrice });
  }

  return json({
    ok: true,
    total: (entries.results || []).length,
    updated,
    unchanged,
    skipped_no_item: skippedNoItem,
    skipped_not_in_menu: skippedNotInMenu,
    details,
  });
}
