// 下載：24 小時內可重複下載，到期後連結失效
// v1.0.60 動態 build XLSX：每次下載用最新 entries 重 build，含 v1.0.58 應付明細
//         舊 blob 不用，只用 token → task_id 查對應
import { buildExportResponse } from '../api/t/[taskId]/export.js';

export async function onRequestGet({ params, env }) {
  const token = String(params.token || '');
  if (!token) return new Response('Bad token', { status: 400 });

  const row = await env.DB.prepare(
    `SELECT task_id, filename, expires_at, download_count FROM exports WHERE token = ?`
  ).bind(token).first();

  if (!row) return new Response('找不到檔案', { status: 404 });

  // 到期檢查（若沒 expires_at 欄位或為空 → 視為永久有效以向下相容舊資料）
  if (row.expires_at) {
    const expMs = Date.parse(row.expires_at.replace(' ', 'T') + 'Z');
    if (Number.isFinite(expMs) && Date.now() > expMs) {
      const tpe = new Date(expMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
      return new Response(
        `<!DOCTYPE html><meta charset="utf-8"><title>已到期</title><style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:480px;margin:80px auto;padding:16px;text-align:center;color:#666}</style><h2>⏰ 下載連結已到期</h2><p>此連結於 ${tpe}（台北時間）到期，請向管理員重新索取。</p>`,
        { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
  }

  // 累計下載次數（統計用，不擋人）
  await env.DB.prepare(`UPDATE exports SET download_count = COALESCE(download_count, 0) + 1 WHERE token = ?`).bind(token).run();

  // v1.0.60 動態 build：用 task_id 查最新 entries 重 build XLSX（含應付明細）
  if (row.task_id) {
    return buildExportResponse(env, row.task_id, row.filename);
  }

  // fallback：老資料沒 task_id（理論上不會有），回 404
  return new Response('exports 資料缺 task_id', { status: 500 });
}
