// 看板點餐：使用者在 /t/:id 看板挑了品項 + 選了哪一區 → 寫入 entries
// POST body: { zone, item, price?, note? }
// 匿名身份：user_id = 'web:<taskId>:<zone>'，並在 members 建/更新同 id 的影子紀錄
import { upsertEntry } from '../../line/_tasks.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ env, params, request }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);
  const body = await request.json().catch(() => ({}));
  const zone = String(body.zone || '').trim();
  const isLeave = !!body.leave;
  const item = String(body.item || '').trim();
  if (!zone) return json({ error: 'zone 不可為空' }, 400);
  if (!isLeave && !item) return json({ error: 'item 不可為空' }, 400);
  const note = body.note == null ? null : String(body.note).slice(0, 60);
  const price = body.price == null || body.price === '' ? null : +body.price;
  const sweet = body.sweet == null ? null : String(body.sweet).slice(0, 10);
  const ice = body.ice == null ? null : String(body.ice).slice(0, 10);
  const memberName = (body.memberName == null ? '' : String(body.memberName)).trim().slice(0, 20) || null;
  const nonMemberName = (body.nonMemberName == null ? '' : String(body.nonMemberName)).trim().slice(0, 20) || null;
  // v1.0.49 不分區群組（v1.0.50 撤回個人袋子，袋子改 task.shared_addon 共同成本）
  const noZoneGroup = !!body.noZoneGroup;
  const memberUserId = (body.memberUserId == null ? '' : String(body.memberUserId)).trim() || null;
  if (price != null && (isNaN(price) || price < 0 || price > 100000)) {
    return json({ error: 'bad price' }, 400);
  }

  const task = await env.DB.prepare(
    `SELECT id, status, menu_json, group_id FROM tasks WHERE id = ?`
  ).bind(taskId).first();
  if (!task) return json({ error: 'task not found' }, 404);
  if (task.status === 'closed') return json({ error: 'task closed' }, 400);

  // v1.0.49 不分區群組：跳過 zones 表驗證，視同 unlimited 走名字當 key
  let unlimited = false;
  if (noZoneGroup) {
    unlimited = true; // 不分區強制 unlimited，每筆獨立 user_id 避免衝突（用名字當 key）
  } else {
    const zrow = await env.DB.prepare(
      `SELECT name, capacity FROM zones WHERE name = ? AND enabled = 1`
    ).bind(zone).first();
    if (!zrow) return json({ error: 'zone 未啟用或不存在' }, 400);
    // capacity = 0 → 該區不限人數（例：檢驗中心/衛生局），每次都開新紀錄
    unlimited = +zrow.capacity === 0;
  }
  // v1.0.49 不分區群組：必填名字（會員/非會員）
  if (noZoneGroup && !memberName && !nonMemberName) {
    return json({ error: '不分區群組需指定 會員 或 非會員姓名' }, 400);
  }
  // 衛生局：一定要挑會員 或 非會員姓名
  if (!noZoneGroup && /衛生局/.test(zone) && !memberName && !nonMemberName) {
    return json({ error: '衛生局需指定 會員 或 非會員姓名' }, 400);
  }
  // 非衛生局/非不分區區：若沒傳名字，自動從花名冊補上該區的人
  let autoName = null;
  if (!noZoneGroup && !/衛生局/.test(zone) && !memberName && !nonMemberName) {
    try {
      const hit = await env.DB.prepare(
        `SELECT real_name FROM roster WHERE zone = ? LIMIT 1`
      ).bind(zone).first();
      if (hit?.real_name) autoName = hit.real_name;
    } catch {}
  }

  // 菜單模式：item 必須在菜單上（防止前端亂送）；custom=true 允許菜單外；leave 跳過
  const isCustom = !!body.custom;
  if (!isLeave && task.menu_json && !isCustom) {
    const menu = JSON.parse(task.menu_json);
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const hit = menu.find(it => norm(it.name) === norm(item));
    if (!hit) return json({ error: '品項不在菜單上' }, 400);
  }

  // 身份辨識 + 顯示名
  const isNon = !!nonMemberName;
  const displayName = memberName || nonMemberName || zone;
  // v1.0.49 不分區群組：若有 memberUserId（LINE 真人）→ 用該 user_id（會 upsert 既有 entry，避免重複）
  //   - 否則用名字當 key
  // 衛生局會員用姓名當 key（避免同一會員代點成多筆），非會員每筆獨立
  let userId;
  if (noZoneGroup) {
    if (memberUserId) {
      userId = memberUserId; // 用真實 LINE userId，看板會跟 LINE 訊息那筆合併
    } else if (memberName) {
      userId = `web:${taskId}:group:m:${memberName}`;
    } else {
      userId = `web:${taskId}:group:n:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    }
  } else if (/衛生局/.test(zone)) {
    userId = memberName
      ? `web:${taskId}:${zone}:m:${memberName}`
      : `web:${taskId}:${zone}:n:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  } else {
    userId = unlimited
      ? `web:${taskId}:${zone}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      : `web:${taskId}:${zone}`;
  }
  // members upsert：不分區群組若用真實 LINE userId 就不要覆寫成 web 影子
  if (!(noZoneGroup && memberUserId)) {
    const memberLabel = noZoneGroup
      ? (memberName ? `🌐 ${memberName}` : `🌐 ${nonMemberName}（非會員）`)
      : (/衛生局/.test(zone)
          ? (memberName ? `🌐 ${memberName}` : `🌐 ${nonMemberName}（非會員）`)
          : (autoName ? `🌐 ${autoName}` : `🌐 ${zone}`));
    await env.DB.prepare(
      `INSERT INTO members (user_id, real_name, zone, last_seen_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET zone = excluded.zone, real_name = excluded.real_name, last_seen_at = datetime('now')`
    ).bind(userId, memberLabel, noZoneGroup ? '' : zone).run();
  }

  const data = isLeave ? {} : { 品項: item };
  if (!isLeave) {
    if (sweet) data['甜度'] = sweet;
    if (ice) data['冰塊'] = ice;
  }
  if (memberName) data['姓名'] = memberName;
  if (nonMemberName) { data['姓名'] = nonMemberName; data['身份'] = '非會員'; }
  if (!data['姓名'] && autoName) data['姓名'] = autoName;

  const additive = !!body.additive && !isLeave;
  const finalNote = isLeave ? '請假' : note;
  const finalPrice = isLeave ? null : price;
  const rawText = isLeave
    ? `[web] ${zone} ${displayName}${isNon ? '(非會員)' : ''} → 請假${note ? '（' + note + '）' : ''}`
    : `[web] ${zone} ${displayName}${isNon ? '(非會員)' : ''} → ${item}${sweet ? '/' + sweet : ''}${ice ? '/' + ice : ''}`;
  await upsertEntry(env.DB, {
    taskId, userId,
    data,
    note: finalNote, price: finalPrice,
    rawText,
    additive,
  });

  return json({ ok: true });
}

// v1.0.47 管理員編輯：改 entry 的 data（品項/甜度/冰塊/加料/大小）+ price + note
// PATCH body: { userId, data?: {品項?, 甜度?, 冰塊?, 加料?, 大小?, 葷素?, 份量?, ...}, price?, note? }
//   - data 只覆蓋有提供的欄位（partial update）；要清空某欄位請給空字串
//   - price 給 null 清空；不給就不變
//   - note 給空字串清空
//   - 同 quick-entry.js 其他 method 不額外 admin gate（看板 admin 模式可直接呼叫）
export async function onRequestPatch({ env, params, request }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);
  const body = await request.json().catch(() => ({}));
  const userId = String(body.userId || '').trim();
  if (!userId) return json({ error: 'missing userId' }, 400);

  const row = await env.DB.prepare(
    `SELECT id, data_json, price, note FROM entries WHERE task_id = ? AND user_id = ?`
  ).bind(taskId, userId).first();
  if (!row) return json({ error: 'entry not found' }, 404);

  let data; try { data = JSON.parse(row.data_json || '{}'); } catch { data = {}; }
  if (body.data && typeof body.data === 'object') {
    for (const k of Object.keys(body.data)) {
      const v = body.data[k];
      if (v === null || v === undefined || v === '') {
        delete data[k];
      } else {
        data[k] = String(v).slice(0, 60);
      }
    }
  }

  let newPrice = row.price;
  if (Object.prototype.hasOwnProperty.call(body, 'price')) {
    if (body.price === null || body.price === '') newPrice = null;
    else if (!isNaN(+body.price) && +body.price >= 0 && +body.price <= 100000) newPrice = +body.price;
    else return json({ error: 'bad price' }, 400);
  }

  let newNote = row.note;
  if (Object.prototype.hasOwnProperty.call(body, 'note')) {
    newNote = body.note == null ? null : String(body.note).slice(0, 60) || null;
  }

  await env.DB.prepare(
    `UPDATE entries SET data_json = ?, price = ?, note = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(JSON.stringify(data), newPrice, newNote, row.id).run();

  return json({ ok: true, id: row.id, data, price: newPrice, note: newNote });
}

// 管理員刪除：只允許刪看板建立的 entry（user_id 前綴 web:<taskId>:）
// 不動 LINE 真人資料
export async function onRequestDelete({ env, params, request }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);
  const body = await request.json().catch(() => ({}));
  const userId = String(body.userId || '').trim();
  if (!userId) return json({ error: 'missing userId' }, 400);
  const res = await env.DB.prepare(
    `DELETE FROM entries WHERE task_id = ? AND user_id = ?`
  ).bind(taskId, userId).run();
  // 只清掉影子 member（web: 開頭的）；真人 member 保留
  if (userId.startsWith('web:')) {
    await env.DB.prepare(
      `DELETE FROM members WHERE user_id = ?`
    ).bind(userId).run();
  }
  return json({ ok: true, changes: res.meta?.changes ?? 0 });
}
