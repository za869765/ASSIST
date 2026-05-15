// 按 task 的 menu_json 重算所有 entries 的 price
// v1.0.44 修 menu OCR 抽 M 價導致 entries.price 殘留錯誤的問題
// v1.0.45 加料金額也納入：base (品項 L 價) + Σ addon (data.加料 對應 menu 加料 price)
// POST /api/admin/tasks/<id>/reprice
//   - 比對 menu_json 中 category!=加料 的品項 → 取為 base price
//   - 比對 menu_json 中 category=加料 的品項 → 取為 addon price 表
//   - data.加料 用「、，,／/」拆 token 分別查 addon 表加總
//   - 沒 data.品項、不在菜單的品項、加料找不到都會記在 details
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
  const baseMap = new Map();   // 飲料/正常品項 price
  const addonMap = new Map();  // 加料 price
  for (const it of menu) {
    if (!it.name || it.price == null) continue;
    if (String(it.category || '') === '加料') {
      addonMap.set(norm(it.name), +it.price);
    } else {
      baseMap.set(norm(it.name), +it.price);
    }
  }
  if (!baseMap.size) return json({ error: '菜單沒有任何含價格的基本品項' }, 400);

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
    const basePrice = baseMap.get(norm(item));
    if (basePrice == null) {
      skippedNotInMenu++;
      details.push({ id: e.id, item, old: e.price, new: null, reason: 'not in menu' });
      continue;
    }
    // v1.0.45/54: 計算加料加總
    //   優先取 data['加料']；若該欄空，掃 data 所有 value（除品項/甜度/冰塊/大小等基本欄位）
    //   把每個 value 拆 token 試 match 加料 menu_json
    //   這樣 Gemini extract 把「珍珠」放到 data['加購'] 或別的 key 也能算到
    const KNOWN_NON_ADDON = new Set(['品項', '甜度', '冰塊', '大小', '葷素', '份量', '飯量', '辣度', '備註', '忌口', '姓名', '身份']);
    const addonValues = [];
    if (data['加料']) {
      addonValues.push(String(data['加料']));
    } else {
      // fallback：掃其他非基本欄位的 value
      for (const k of Object.keys(data)) {
        if (KNOWN_NON_ADDON.has(k)) continue;
        const v = data[k];
        if (v && typeof v === 'string') addonValues.push(v);
      }
    }
    const addonTokens = addonValues.flatMap(s => String(s).split(/[、,，／/\s]+/).map(t => t.trim()).filter(Boolean));
    const addonHits = [];
    const addonMissed = [];
    let addonSum = 0;
    for (const t of addonTokens) {
      // 先精確 match，再 fuzzy（「珍珠」可 match 加料區的「波霸」「小珍珠」「混珠」任一，取 +5）
      let ap = addonMap.get(norm(t));
      if (ap == null) {
        const nt = norm(t);
        // fuzzy: 看 addonMap 有沒有 key 含 nt 或 nt 含 key
        for (const [k, v] of addonMap.entries()) {
          if (k.includes(nt) || nt.includes(k)) { ap = v; break; }
        }
      }
      if (ap != null) {
        addonSum += ap;
        addonHits.push({ name: t, price: ap });
      } else {
        addonMissed.push(t);
      }
    }
    const newPrice = basePrice + addonSum;
    if (newPrice === +e.price) {
      unchanged++;
      if (addonHits.length || addonMissed.length) {
        details.push({ id: e.id, item, base: basePrice, addons: addonHits, addons_missed: addonMissed, old: e.price, new: newPrice, note: 'unchanged' });
      }
      continue;
    }
    await env.DB.prepare(`UPDATE entries SET price = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(newPrice, e.id).run();
    updated++;
    details.push({ id: e.id, item, base: basePrice, addons: addonHits, addons_missed: addonMissed, old: e.price, new: newPrice });
  }

  return json({
    ok: true,
    total: (entries.results || []).length,
    updated,
    unchanged,
    skipped_no_item: skippedNoItem,
    skipped_not_in_menu: skippedNotInMenu,
    addon_items_in_menu: addonMap.size,
    details,
  });
}
