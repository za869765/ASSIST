// 下載：24 小時內可重複下載，到期後連結失效
export async function onRequestGet({ params, env }) {
  const token = String(params.token || '');
  if (!token) return new Response('Bad token', { status: 400 });

  const row = await env.DB.prepare(
    `SELECT filename, content_type, blob, expires_at, download_count FROM exports WHERE token = ?`
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

  let bytes;
  if (row.blob instanceof Uint8Array) bytes = row.blob;
  else if (row.blob instanceof ArrayBuffer) bytes = new Uint8Array(row.blob);
  else if (typeof row.blob === 'string') {
    try { bytes = Uint8Array.from(atob(row.blob), c => c.charCodeAt(0)); }
    catch { bytes = new TextEncoder().encode(row.blob); }
  } else {
    bytes = new Uint8Array(Object.values(row.blob || {}));
  }

  return new Response(bytes, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}
