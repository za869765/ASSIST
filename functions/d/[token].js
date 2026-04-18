// 一次性下載：查 exports 表，used=0 才給下載，下載後標為 used=1
export async function onRequestGet({ params, env }) {
  const token = String(params.token || '');
  if (!token) return new Response('Bad token', { status: 400 });

  const row = await env.DB.prepare(
    `SELECT filename, content_type, blob, used FROM exports WHERE token = ?`
  ).bind(token).first();

  if (!row) return new Response('找不到檔案', { status: 404 });
  if (row.used) {
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><title>已使用</title><style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:480px;margin:80px auto;padding:16px;text-align:center;color:#666}</style><h2>🔒 此連結已下載過</h2><p>一次性下載連結已失效，請重新結單或向管理員索取。</p>',
      { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  // 標記為已使用
  await env.DB.prepare(`UPDATE exports SET used = 1 WHERE token = ?`).bind(token).run();

  // D1 BLOB 回來的可能是 ArrayBuffer / Uint8Array / base64 string，視 runtime 而定
  let bytes;
  if (row.blob instanceof Uint8Array) bytes = row.blob;
  else if (row.blob instanceof ArrayBuffer) bytes = new Uint8Array(row.blob);
  else if (typeof row.blob === 'string') {
    // 若是 base64 就解
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
