// 即時點單看板（server-rendered HTML，5 秒自動刷新）
export async function onRequestGet({ params, request, env }) {
  const key = String(params.id || '');
  if (!key) return new Response('Bad id', { status: 400 });
  // 優先以 slug 查；找不到再以數字 id 向下相容
  let task = await env.DB.prepare(
    `SELECT id, task_name, mode, status, started_at, closed_at, view_token FROM tasks WHERE url_slug = ?`
  ).bind(key).first();
  if (!task && /^\d+$/.test(key)) {
    task = await env.DB.prepare(
      `SELECT id, task_name, mode, status, started_at, closed_at, view_token FROM tasks WHERE id = ?`
    ).bind(parseInt(key, 10)).first();
  }
  if (!task) return new Response('Not found', { status: 404 });

  // 結單後：一律關閉公開看板
  if (task.status === 'closed') {
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><title>已結單</title><style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:480px;margin:80px auto;padding:16px;text-align:center;color:#666}</style><h2>🔒 此任務已結單</h2><p>看板已停止公開，請洽管理員索取結果檔案。</p>',
      { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const entries = await env.DB.prepare(
    `SELECT e.user_id, e.data_json, e.note, e.price, e.updated_at,
            m.real_name, m.line_display
       FROM entries e
       LEFT JOIN members m ON m.user_id = e.user_id
      WHERE e.task_id = ?
      ORDER BY e.updated_at ASC`
  ).bind(task.id).all();
  const rows = entries.results || [];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const lis = rows.map((e) => {
    const name = e.real_name || e.line_display || e.user_id.slice(0, 6);
    const data = JSON.parse(e.data_json || '{}');
    const parts = Object.values(data).filter(Boolean).join(' / ');
    const body = parts || (e.note === '不吃' ? '不吃' : '(未辨識)');
    const noteShown = parts && e.note ? `（${esc(e.note)}）` : '';
    const price = e.price ? ` $${e.price}` : '';
    return `<li><span class="who">${esc(name)}</span><span class="body">${esc(body)}${noteShown}</span><span class="price">${esc(price)}</span></li>`;
  }).join('');

  const total = rows.reduce((s, e) => s + (e.price || 0), 0);
  const closed = task.status === 'closed';
  const statusLabel = closed ? '已結單' : '進行中';
  const refresh = closed ? '' : '<meta http-equiv="refresh" content="5">';
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
${refresh}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(task.task_name)}｜即時點單</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif; max-width: 640px; margin: 0 auto; padding: 16px; line-height: 1.5; }
h1 { margin: 0 0 4px; font-size: 20px; }
.meta { color: #888; font-size: 13px; margin-bottom: 16px; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
.pill.open { background: #2db87a; color: white; }
.pill.closed { background: #888; color: white; }
ul { list-style: none; padding: 0; margin: 0; }
li { display: grid; grid-template-columns: 80px 1fr auto; gap: 8px; padding: 10px 0; border-bottom: 1px solid #eee2; align-items: baseline; }
.who { font-weight: 600; }
.body { word-break: break-all; }
.price { color: #2db87a; font-variant-numeric: tabular-nums; }
.total { text-align: right; font-weight: 600; margin-top: 12px; font-size: 16px; }
.empty { color: #888; text-align: center; padding: 32px 0; }
</style>
</head>
<body>
<h1>${esc(task.task_name)} <span class="pill ${closed ? 'closed' : 'open'}">${statusLabel}</span></h1>
<div class="meta">開始於 ${esc(task.started_at)}${closed ? `・結單於 ${esc(task.closed_at)}` : ''}・共 ${rows.length} 筆${closed ? '' : '・每 5 秒自動更新'}</div>
${rows.length ? `<ul>${lis}</ul>${total ? `<div class="total">合計：$${total}</div>` : ''}` : '<div class="empty">還沒有人填～</div>'}
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
