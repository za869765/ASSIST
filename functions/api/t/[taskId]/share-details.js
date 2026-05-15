// v1.0.50 GET /api/t/<taskId>/share-details
// 算每人應付明細（買五送一折扣 + 共同袋子成本 + 餘數扣袋子 + 多付清單輪序）
//
// 回傳：{
//   total_items: 飲料合計（含個人加料，不含買五送一折扣與共同袋子）
//   discount: 買五送一折扣
//   shared_addon: 共同袋子成本
//   payable: total_items - discount + shared_addon
//   n_payers: 應付人數（有 price 的 entries 數）
//   base: floor(payable / n)
//   remainder: payable - base*n（多收的元數，這 remainder 個人付 base+1）
//   bag_offset: min(remainder, shared_addon)（從餘數抵掉的袋子成本）
//   real_overpay: max(0, remainder - bag_offset)（真正進多付清單的人數）
//   per_entry: [{ user_id, name, price, due, role: 'overpay'|'bag'|'base'|'skip' }]
//     - due: 應付金額
//     - role:
//         - 'skip' = 無 price（請假/沒下單）
//         - 'base' = 付 base 元，不在多付名單
//         - 'bag'  = 付 base+1 元，這 1 元算共同袋子成本（不記入多付清單）
//         - 'overpay' = 付 base+1 元，這 1 元算多付（記入多付清單）
// }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ env, params }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);

  // 抓 task（含新欄位容錯）
  let task;
  try {
    task = await env.DB.prepare(
      `SELECT id, task_name, group_id, mode, buy5_get1, shared_addon FROM tasks WHERE id = ?`
    ).bind(taskId).first();
  } catch {
    task = await env.DB.prepare(
      `SELECT id, task_name, group_id, mode FROM tasks WHERE id = ?`
    ).bind(taskId).first();
  }
  if (!task) return json({ error: 'task not found' }, 404);

  const buy5 = !!task.buy5_get1;
  const sharedAddon = Math.max(0, +(task.shared_addon || 0));

  // 抓 entries
  const r = await env.DB.prepare(
    `SELECT e.id, e.user_id, e.data_json, e.note, e.price,
            COALESCE(gm.real_name, m.real_name) AS real_name,
            m.line_display
       FROM entries e
       LEFT JOIN group_members gm ON gm.group_id = ? AND gm.user_id = e.user_id
       LEFT JOIN members m         ON m.user_id  = e.user_id
      WHERE e.task_id = ?
      ORDER BY e.updated_at ASC`
  ).bind(task.group_id || '', taskId).all();
  const entries = (r.results || []).map(e => {
    let data; try { data = JSON.parse(e.data_json || '{}'); } catch { data = {}; }
    return {
      id: e.id,
      user_id: e.user_id,
      name: e.real_name || e.line_display || data['姓名'] || (e.user_id || '').slice(0, 6),
      price: +e.price || 0,
      note: e.note || '',
      isLeave: e.note === '請假' || e.note === '不吃',
    };
  });

  const payers = entries.filter(e => !e.isLeave && e.price > 0);
  const n = payers.length;

  // 算飲料合計與買五送一折扣
  const totalItems = payers.reduce((s, e) => s + e.price, 0);
  // v1.0.51 買五送一規則：組內【最貴】那杯免費（sorted[i+5]）
  let discount = 0;
  const freeIds = new Set();
  if (buy5 && n >= 6) {
    const sorted = [...payers].sort((a, b) => a.price - b.price);
    for (let i = 0; i + 6 <= sorted.length; i += 6) {
      const mostExpensive = sorted[i + 5];
      freeIds.add(mostExpensive.id);
      discount += mostExpensive.price;
    }
  }

  const payable = totalItems - discount + sharedAddon;
  if (n === 0) {
    return json({
      total_items: totalItems, discount, shared_addon: sharedAddon, payable,
      n_payers: 0, base: 0, remainder: 0, bag_offset: 0, real_overpay: 0,
      per_entry: entries.map(e => ({ user_id: e.user_id, name: e.name, price: e.price, due: 0, role: 'skip' })),
    });
  }

  const base = Math.floor(payable / n);
  const remainder = payable - base * n; // 0 ~ n-1
  const bagOffset = Math.min(remainder, sharedAddon);
  const realOverpay = Math.max(0, remainder - bagOffset);

  // 跨任務多付累計（讀 D1）；若 migration 未跑就空 map
  const balanceMap = new Map();
  if (task.group_id) {
    try {
      const br = await env.DB.prepare(
        `SELECT user_id, overpaid_count FROM group_member_balance WHERE group_id = ?`
      ).bind(task.group_id).all();
      for (const row of (br.results || [])) {
        balanceMap.set(row.user_id, +row.overpaid_count || 0);
      }
    } catch {}
  }

  // 排序：累計多付最少 → 多 → 同分依名字
  // 從前 `remainder` 個挑出來「+1 元」（前 bagOffset 個算袋子、後 realOverpay 個算真多付）
  const sortedPayers = [...payers].sort((a, b) => {
    const ba = balanceMap.get(a.user_id) || 0;
    const bb = balanceMap.get(b.user_id) || 0;
    if (ba !== bb) return ba - bb;
    return String(a.name).localeCompare(String(b.name), 'zh-Hant');
  });
  const overpayIds = new Set(); // payer.id 集合：付 base+1
  const bagPayerIds = new Set(); // 其中 bagOffset 個算袋子（不記多付）
  for (let i = 0; i < remainder; i++) {
    const p = sortedPayers[i];
    if (!p) break;
    overpayIds.add(p.id);
    if (i < bagOffset) bagPayerIds.add(p.id);
  }

  const per_entry = entries.map(e => {
    if (e.isLeave) return { user_id: e.user_id, name: e.name, price: 0, due: 0, role: 'skip' };
    if (e.price <= 0) return { user_id: e.user_id, name: e.name, price: 0, due: 0, role: 'skip' };
    const isFree = freeIds.has(e.id);
    const isOverpay = overpayIds.has(e.id);
    const isBagPayer = bagPayerIds.has(e.id);
    return {
      user_id: e.user_id,
      name: e.name,
      price: e.price,
      free: isFree,
      due: isOverpay ? base + 1 : base,
      role: isOverpay ? (isBagPayer ? 'bag' : 'overpay') : 'base',
      balance_before: balanceMap.get(e.user_id) || 0,
    };
  });

  return json({
    total_items: totalItems,
    discount,
    shared_addon: sharedAddon,
    payable,
    n_payers: n,
    base,
    remainder,
    bag_offset: bagOffset,
    real_overpay: realOverpay,
    per_entry,
  });
}
