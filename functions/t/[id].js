// 即時點單看板（server-rendered HTML，5 秒自動刷新）
export async function onRequestGet({ params, request, env }) {
  const key = String(params.id || '');
  if (!key) return new Response('Bad id', { status: 400 });
  // 優先以 slug 查；找不到再以數字 id 向下相容
  let task = await env.DB.prepare(
    `SELECT id, task_name, mode, status, started_at, closed_at, view_token, group_id, url_slug FROM tasks WHERE url_slug = ?`
  ).bind(key).first();
  if (!task && /^\d+$/.test(key)) {
    task = await env.DB.prepare(
      `SELECT id, task_name, mode, status, started_at, closed_at, view_token, group_id, url_slug FROM tasks WHERE id = ?`
    ).bind(parseInt(key, 10)).first();
  }
  if (!task) return new Response('Not found', { status: 404 });

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  // 結單後：若同群組還有進行中任務 → 列出並引導切換；都沒了才顯示「已結單」
  if (task.status === 'closed') {
    const openRow = await env.DB.prepare(
      `SELECT id, task_name, url_slug FROM tasks WHERE group_id = ? AND status = 'open' ORDER BY started_at ASC`
    ).bind(task.group_id).all();
    const open = openRow.results || [];
    if (open.length) {
      // 只有一個進行中 → 直接 302 到那個
      if (open.length === 1) {
        const o = open[0];
        return Response.redirect(new URL(`/t/${o.url_slug || o.id}`, request.url).toString(), 302);
      }
      // 多個 → 顯示選單
      const body = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>請選擇任務</title><style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:480px;margin:40px auto;padding:16px}h2{font-size:18px}a.item{display:block;padding:14px 16px;margin:8px 0;background:#2db87a;color:white;text-decoration:none;border-radius:8px;font-size:16px}small{color:#888}</style></head><body><h2>「${esc(task.task_name)}」已結單</h2><small>以下是此群組還在進行中的任務：</small>${open.map(t => `<a class="item" href="/t/${esc(t.url_slug || t.id)}">${esc(t.task_name)} →</a>`).join('')}</body></html>`;
      return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return new Response(
      `<!DOCTYPE html><meta charset="utf-8"><title>已結單｜${esc(task.task_name)}</title><style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:480px;margin:80px auto;padding:16px;text-align:center;color:#666}</style><h2>🔒 「${esc(task.task_name)}」已結單</h2><p>此任務看板已停止公開，請洽管理員索取結果檔案。</p>`,
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

  // 同群組其他進行中任務（做上方分頁切換）
  const siblingsRow = await env.DB.prepare(
    `SELECT id, task_name, url_slug FROM tasks WHERE group_id = ? AND status = 'open' ORDER BY started_at ASC`
  ).bind(task.group_id).all();
  const siblings = (siblingsRow.results || []);
  const tabs = siblings.length > 1
    ? `<nav class="tabs">${siblings.map(t => {
        const active = t.id === task.id;
        const href = `/t/${t.url_slug || t.id}`;
        return `<a class="tab${active ? ' active' : ''}" href="${esc(href)}">${esc(t.task_name)}</a>`;
      }).join('')}</nav>`
    : '';
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
.tabs { display: flex; gap: 4px; margin: -4px 0 12px; border-bottom: 1px solid #ddd4; overflow-x: auto; }
.tab { padding: 8px 14px; text-decoration: none; color: #888; border-bottom: 2px solid transparent; white-space: nowrap; font-size: 14px; }
.tab.active { color: inherit; border-bottom-color: #2db87a; font-weight: 600; }
</style>
</head>
<body>
${tabs}
<h1>${esc(task.task_name)} <span class="pill ${closed ? 'closed' : 'open'}">${statusLabel}</span></h1>
<div class="meta">開始於 ${esc(task.started_at)}${closed ? `・結單於 ${esc(task.closed_at)}` : ''}・共 ${rows.length} 筆${closed ? '' : '・每 5 秒自動更新'}</div>
${rows.length ? `<ul>${lis}</ul>${total ? `<div class="total">合計：$${total}</div>` : ''}` : '<div class="empty">還沒有人填～</div>'}
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
