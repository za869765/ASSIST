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
  const item = String(body.item || '').trim();
  if (!zone || !item) return json({ error: 'zone 與 item 不可為空' }, 400);
  const note = body.note == null ? null : String(body.note).slice(0, 60);
  const price = body.price == null || body.price === '' ? null : +body.price;
  const sweet = body.sweet == null ? null : String(body.sweet).slice(0, 10);
  const ice = body.ice == null ? null : String(body.ice).slice(0, 10);
  const memberName = (body.memberName == null ? '' : String(body.memberName)).trim().slice(0, 20) || null;
  const nonMemberName = (body.nonMemberName == null ? '' : String(body.nonMemberName)).trim().slice(0, 20) || null;
  if (price != null && (isNaN(price) || price < 0 || price > 100000)) {
    return json({ error: 'bad price' }, 400);
  }

  const task = await env.DB.prepare(
    `SELECT id, status, menu_json FROM tasks WHERE id = ?`
  ).bind(taskId).first();
  if (!task) return json({ error: 'task not found' }, 404);
  if (task.status === 'closed') return json({ error: 'task closed' }, 400);

  const zrow = await env.DB.prepare(
    `SELECT name, capacity FROM zones WHERE name = ? AND enabled = 1`
  ).bind(zone).first();
  if (!zrow) return json({ error: 'zone 未啟用或不存在' }, 400);
  // capacity = 0 → 該區不限人數（例：檢驗中心/衛生局），每次都開新紀錄
  const unlimited = +zrow.capacity === 0;
  // 衛生局：一定要挑會員 或 非會員姓名
  if (/衛生局/.test(zone) && !memberName && !nonMemberName) {
    return json({ error: '衛生局需指定 會員 或 非會員姓名' }, 400);
  }
  // 非衛生局區：若沒傳名字，自動從花名冊補上該區的人
  let autoName = null;
  if (!/衛生局/.test(zone) && !memberName && !nonMemberName) {
    try {
      const hit = await env.DB.prepare(
        `SELECT real_name FROM roster WHERE zone = ? LIMIT 1`
      ).bind(zone).first();
      if (hit?.real_name) autoName = hit.real_name;
    } catch {}
  }

  // 菜單模式：item 必須在菜單上（防止前端亂送）；custom=true 允許菜單外
  const isCustom = !!body.custom;
  if (task.menu_json && !isCustom) {
    const menu = JSON.parse(task.menu_json);
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const hit = menu.find(it => norm(it.name) === norm(item));
    if (!hit) return json({ error: '品項不在菜單上' }, 400);
  }

  // 身份辨識 + 顯示名
  const isNon = !!nonMemberName;
  const displayName = memberName || nonMemberName || zone;
  // 衛生局會員用姓名當 key（避免同一會員代點成多筆），非會員每筆獨立
  const userId = /衛生局/.test(zone)
    ? (memberName
        ? `web:${taskId}:${zone}:m:${memberName}`
        : `web:${taskId}:${zone}:n:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
    : (unlimited
        ? `web:${taskId}:${zone}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        : `web:${taskId}:${zone}`);
  const memberLabel = /衛生局/.test(zone)
    ? (memberName ? `🌐 ${memberName}` : `🌐 ${nonMemberName}（非會員）`)
    : (autoName ? `🌐 ${autoName}` : `🌐 ${zone}`);
  await env.DB.prepare(
    `INSERT INTO members (user_id, real_name, zone, last_seen_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET zone = excluded.zone, real_name = excluded.real_name, last_seen_at = datetime('now')`
  ).bind(userId, memberLabel, zone).run();

  const data = { 品項: item };
  if (sweet) data['甜度'] = sweet;
  if (ice) data['冰塊'] = ice;
  if (memberName) data['姓名'] = memberName;
  if (nonMemberName) { data['姓名'] = nonMemberName; data['身份'] = '非會員'; }
  if (!data['姓名'] && autoName) data['姓名'] = autoName;

  await upsertEntry(env.DB, {
    taskId, userId,
    data,
    note, price,
    rawText: `[web] ${zone} ${displayName}${isNon ? '(非會員)' : ''} → ${item}${sweet ? '/' + sweet : ''}${ice ? '/' + ice : ''}`,
    additive: false,
  });

  return json({ ok: true });
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
