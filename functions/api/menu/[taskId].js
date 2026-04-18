// 菜單照片 API：/api/menu/:taskId
//  GET    → 列出此任務的照片 + OCR 品項彙總
//  POST   → 上傳一張照片（multipart/form-data, field 名 "photo"）
//  DELETE → 刪除單張（body: { photoId }）
import { geminiParseMenu } from '../line/_gemini.js';

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

  const task = await env.DB.prepare(`SELECT id, status FROM tasks WHERE id = ?`).bind(taskId).first();
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

  // 更新任務 menu_json 彙總（供 webhook extract 時當白名單提示）
  const agg = await aggregateItems(env.DB, taskId);
  await env.DB.prepare(
    `UPDATE tasks SET menu_json = ?, mode = 'menu' WHERE id = ?`
  ).bind(JSON.stringify(agg), taskId).run();

  return json({ id, itemCount: items.length, items, aggItems: agg });
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
  } else {
    await env.DB.prepare(`UPDATE tasks SET menu_json = ? WHERE id = ?`).bind(JSON.stringify(agg), taskId).run();
  }
  return json({ ok: true, aggItems: agg });
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
