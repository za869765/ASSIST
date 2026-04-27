// 菜單照片 API：/api/menu/:taskId
//  GET    → 列出此任務的照片 + OCR 品項彙總
//  POST   → 上傳一張照片（multipart/form-data, field 名 "photo"）
//  DELETE → 刪除單張（body: { photoId }）
import { geminiParseMenu, geminiOrganizeMenu } from '../line/_gemini.js';

function uuid() {
  // 短亂數 id，避免引入 crypto.randomUUID 以相容舊環境
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function aggregateItems(DB, taskId) {
  const rows = await DB.prepare(
    `SELECT items_json FROM menu_photos WHERE task_id = ? ORDER BY created_at`
  ).bind(taskId).all();
  const seen = new Map();
  for (const r of (rows.results || [])) {
    const items = JSON.parse(r.items_json || '[]');
    for (const it of items) {
      const key = String(it.name || '').replace(/\s+/g, '').toLowerCase();
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, it);
    }
  }
  return [...seen.values()];
}

export async function onRequestGet({ env, params }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);
  const photos = await env.DB.prepare(
    `SELECT id, mime, size, items_json, created_at FROM menu_photos WHERE task_id = ? ORDER BY created_at`
  ).bind(taskId).all();
  const list = (photos.results || []).map(p => ({
    id: p.id,
    mime: p.mime,
    size: p.size,
    itemCount: JSON.parse(p.items_json || '[]').length,
    created_at: p.created_at,
    url: `/api/menu/${taskId}/file/${p.id}`,
  }));
  const items = await aggregateItems(env.DB, taskId);
  return json({ photos: list, items });
}

export async function onRequestPost({ env, params, request }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);
  if (!env.MENU_BUCKET) return json({ error: 'R2 bucket binding missing' }, 500);

  // 用戶要求拿掉密碼；保留每分鐘 1 次速限避免外部燒 Gemini/R2 額度
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS menu_upload_log (task_id INTEGER PRIMARY KEY, uploaded_at TEXT)`
  ).run();
  const cooldown = await env.DB.prepare(
    `SELECT uploaded_at FROM menu_upload_log WHERE task_id = ? AND uploaded_at > datetime('now','-1 minute')`
  ).bind(taskId).first();
  if (cooldown) {
    return json({ error: '上傳冷卻中（每任務 1/min）' }, 429);
  }

  const task = await env.DB.prepare(`SELECT id, status, group_id FROM tasks WHERE id = ?`).bind(taskId).first();
  if (!task) return json({ error: 'task not found' }, 404);
  if (task.status === 'closed') return json({ error: 'task closed' }, 400);

  const form = await request.formData();
  const file = form.get('photo');
  if (!file || typeof file === 'string') return json({ error: 'no photo field' }, 400);
  const mime = file.type || 'image/jpeg';
  if (!/^image\//.test(mime)) return json({ error: 'not an image' }, 400);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > 10 * 1024 * 1024) return json({ error: 'file too large (>10MB)' }, 400);

  const id = uuid();
  const r2Key = `menu/${taskId}/${id}`;
  await env.MENU_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: mime } });

  // 同步呼叫 Gemini OCR（失敗也不擋：照片仍存下來）
  let items = [];
  try {
    const b64 = bytesToBase64(bytes);
    const ocr = await geminiParseMenu(env.GEMINI_API_KEY, b64, mime);
    items = ocr.items || [];
  } catch (e) {
    console.error('[menu ocr]', e);
  }

  await env.DB.prepare(
    `INSERT INTO menu_photos (id, task_id, r2_key, mime, size, items_json) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, taskId, r2Key, mime, bytes.byteLength, JSON.stringify(items)).run();

  // bug #4: 紀錄速限時戳（成功上傳後才寫，失敗不佔冷卻）
  await env.DB.prepare(
    `INSERT INTO menu_upload_log (task_id, uploaded_at) VALUES (?, datetime('now'))
     ON CONFLICT(task_id) DO UPDATE SET uploaded_at = excluded.uploaded_at`
  ).bind(taskId).run();

  // 彙總 + 交 AI 再整理（去重/修名/分類/排序）→ 存為 menu_json
  const agg = await aggregateItems(env.DB, taskId);
  let finalItems = agg;
  try {
    const org = await geminiOrganizeMenu(env.GEMINI_API_KEY, agg);
    if (Array.isArray(org?.items) && org.items.length) finalItems = org.items;
  } catch (e) { console.error('[menu organize]', e); }
  await env.DB.prepare(
    `UPDATE tasks SET menu_json = ?, mode = 'menu' WHERE id = ?`
  ).bind(JSON.stringify(finalItems), taskId).run();

  return json({ id, itemCount: items.length, items, aggItems: finalItems });
}

// PATCH：修改單一品項（名稱/價格；OCR 亂碼可手動調整）/ body: { name, newName?, price? }
export async function onRequestPatch({ env, params, request }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);
  const body = await request.json().catch(() => ({}));
  const targetName = String(body.name || '').trim();
  const hasNewName = body.newName !== undefined;
  const newName = hasNewName ? String(body.newName || '').trim() : null;
  const hasPrice = body.price !== undefined;
  const newPrice = hasPrice ? (body.price == null || body.price === '' ? null : +body.price) : undefined;
  if (!targetName) return json({ error: 'no name' }, 400);
  if (hasNewName && !newName) return json({ error: 'newName 不可為空' }, 400);
  if (hasNewName && newName.length > 60) return json({ error: 'newName 過長' }, 400);
  if (hasPrice && newPrice != null && (isNaN(newPrice) || newPrice < 0 || newPrice > 100000)) {
    return json({ error: 'bad price' }, 400);
  }
  const task = await env.DB.prepare(`SELECT menu_json FROM tasks WHERE id = ?`).bind(taskId).first();
  if (!task?.menu_json) return json({ error: 'no menu' }, 400);
  const items = JSON.parse(task.menu_json);
  const idx = items.findIndex(it => String(it.name || '').trim() === targetName);
  if (idx < 0) return json({ error: 'item not found' }, 404);
  // 新名字不能跟其他既有品項重複
  if (hasNewName && newName !== targetName) {
    const dup = items.findIndex((it, i) => i !== idx && String(it.name || '').trim() === newName);
    if (dup >= 0) return json({ error: '新名稱已存在' }, 400);
  }
  const patched = { ...items[idx] };
  if (hasNewName) patched.name = newName;
  if (hasPrice) patched.price = newPrice;
  items[idx] = patched;
  await env.DB.prepare(`UPDATE tasks SET menu_json = ? WHERE id = ?`).bind(JSON.stringify(items), taskId).run();
  // 清掉舊的推薦快取（菜單變了推薦也可能變）
  try { await env.DB.prepare(`DELETE FROM menu_recommend WHERE task_id = ?`).bind(taskId).run(); } catch {}
  return json({ ok: true, items });
}

export async function onRequestDelete({ env, params, request }) {
  const taskId = +params.taskId;
  const body = await request.json().catch(() => ({}));
  const photoId = body.photoId;
  if (!taskId || !photoId) return json({ error: 'bad params' }, 400);

  const row = await env.DB.prepare(
    `SELECT r2_key FROM menu_photos WHERE id = ? AND task_id = ?`
  ).bind(photoId, taskId).first();
  if (!row) return json({ error: 'not found' }, 404);

  if (env.MENU_BUCKET) {
    try { await env.MENU_BUCKET.delete(row.r2_key); } catch (e) { console.error('[menu r2 del]', e); }
  }
  await env.DB.prepare(`DELETE FROM menu_photos WHERE id = ?`).bind(photoId).run();

  const agg = await aggregateItems(env.DB, taskId);
  if (agg.length === 0) {
    await env.DB.prepare(`UPDATE tasks SET menu_json = NULL, mode = 'free' WHERE id = ?`).bind(taskId).run();
    return json({ ok: true, aggItems: [] });
  }
  let finalItems = agg;
  try {
    const org = await geminiOrganizeMenu(env.GEMINI_API_KEY, agg);
    if (Array.isArray(org?.items) && org.items.length) finalItems = org.items;
  } catch (e) { console.error('[menu organize]', e); }
  await env.DB.prepare(`UPDATE tasks SET menu_json = ? WHERE id = ?`).bind(JSON.stringify(finalItems), taskId).run();
  return json({ ok: true, aggItems: finalItems });
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
