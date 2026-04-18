// 即時點單看板（按區分組顯示；管理員可拉選人工分區）
export async function onRequestGet({ params, request, env }) {
  const key = String(params.id || '');
  if (!key) return new Response('Bad id', { status: 400 });
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

  if (task.status === 'closed') {
    const openRow = await env.DB.prepare(
      `SELECT id, task_name, url_slug FROM tasks WHERE group_id = ? AND status = 'open' ORDER BY started_at ASC`
    ).bind(task.group_id).all();
    const open = openRow.results || [];
    if (open.length) {
      if (open.length === 1) {
        const o = open[0];
        return Response.redirect(new URL(`/t/${o.url_slug || o.id}`, request.url).toString(), 302);
      }
      const body = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>請選擇任務</title><style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:480px;margin:40px auto;padding:16px}h2{font-size:18px}a.item{display:block;padding:14px 16px;margin:8px 0;background:#2db87a;color:white;text-decoration:none;border-radius:8px;font-size:16px}small{color:#888}</style></head><body><h2>「${esc(task.task_name)}」已結單</h2><small>以下是此群組還在進行中的任務：</small>${open.map(t => `<a class="item" href="/t/${esc(t.url_slug || t.id)}">${esc(t.task_name)} →</a>`).join('')}</body></html>`;
      return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return new Response(
      `<!DOCTYPE html><meta charset="utf-8"><title>已結單｜${esc(task.task_name)}</title><style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:480px;margin:80px auto;padding:16px;text-align:center;color:#666}</style><h2>🔒 「${esc(task.task_name)}」已結單</h2><p>此任務看板已停止公開，請洽管理員索取結果檔案。</p>`,
      { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const entriesRow = await env.DB.prepare(
    `SELECT e.user_id, e.data_json, e.note, e.price, e.updated_at,
            m.real_name, m.line_display, m.zone
       FROM entries e
       LEFT JOIN members m ON m.user_id = e.user_id
      WHERE e.task_id = ?
      ORDER BY e.updated_at ASC`
  ).bind(task.id).all();
  const entries = entriesRow.results || [];

  const zonesRow = await env.DB.prepare(
    `SELECT name, capacity, enabled, sort_order FROM zones WHERE enabled = 1 ORDER BY sort_order ASC, name ASC`
  ).all();
  const zones = zonesRow.results || [];

  const closed = task.status === 'closed';
  const statusLabel = closed ? '已結單' : '進行中';

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

  const initData = {
    task: { id: task.id, name: task.task_name },
    zones,
    entries: entries.map(e => ({
      user_id: e.user_id,
      name: e.real_name || e.line_display || (e.user_id || '').slice(0, 6),
      zone: e.zone || '',
      data: JSON.parse(e.data_json || '{}'),
      note: e.note || '',
      price: e.price || 0,
      updated_at: e.updated_at,
    })),
  };

  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(task.task_name)}｜即時點單</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif; max-width: 440px; margin: 0 auto; padding: 10px 12px; line-height: 1.35; font-size: 13px; }
.card { border: 1px solid #ddd4; border-radius: 8px; padding: 8px 12px; margin-top: 8px; background: #fff1; }
.zone-code { color: #aaa; font-variant-numeric: tabular-nums; margin-right: 4px; font-weight: 400; font-size: 11px; }
h1 { margin: 0 0 2px; font-size: 17px; }
.meta { color: #888; font-size: 11px; margin-bottom: 8px; }
.pill { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 11px; }
.pill.open { background: #2db87a; color: white; }
.pill.closed { background: #888; color: white; }
h2.zone { font-size: 12px; font-weight: 600; margin: 8px 0 2px; padding: 2px 0; border-bottom: 1px solid #ddd4; color: #2db87a; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
h2.zone.none { color: #d4543a; }
h2.zone.empty { color: #aaa; font-weight: 500; }
h2.zone small { color: #888; font-weight: normal; font-size: 11px; }
ul { list-style: none; padding: 0; margin: 0 0 4px; }
li { display: grid; grid-template-columns: 90px 1fr auto; gap: 6px; padding: 3px 0 3px 6px; border-bottom: 1px solid #eee2; align-items: center; }
.uid-row { font-family: monospace; font-size: 9px; color: #bbb; word-break: break-all; font-weight: 400; }
.who { font-weight: 600; font-size: 12px; }
.body { word-break: break-all; font-size: 12px; }
.price { color: #2db87a; font-variant-numeric: tabular-nums; text-align: right; font-size: 12px; }
.zone-sel { padding: 1px 3px; font-size: 10px; border-radius: 3px; border: 1px solid #ccc4; background: #fff1; }
.total { text-align: right; font-weight: 600; margin-top: 10px; font-size: 14px; }
.tabs { display: flex; gap: 6px; margin: 4px 0 12px; overflow-x: auto; }
.tab { flex: 1; min-width: 0; padding: 14px 16px; text-decoration: none; color: #666; background: #e8e8e8; border: 2px solid transparent; border-radius: 10px; white-space: nowrap; font-size: 18px; font-weight: 600; text-align: center; }
.tab.active { color: #fff; background: #2db87a; border-color: #2db87a; }
@media (prefers-color-scheme: dark) { .tab { background: #3a3a3a; color: #aaa; } }
.admin-toggle { float: right; font-size: 11px; color: #888; }
</style>
</head>
<body>
${tabs}
<h1>${esc(task.task_name)} <span class="pill ${closed ? 'closed' : 'open'}">${statusLabel}</span><a class="admin-toggle" href="/admin/zones" target="_blank">🔧 管理員窗口</a></h1>
<div class="meta">開始於 ${esc(task.started_at)}${closed ? `・結單於 ${esc(task.closed_at)}` : ''}・<span id="statLine">—</span>${closed ? '' : '・每 5 秒自動更新'}</div>

<div id="board"></div>

<script>
const INITIAL = ${JSON.stringify(initData)};
let state = INITIAL;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function entryBody(e) {
  const parts = Object.values(e.data || {}).filter(Boolean).join(' / ');
  if (parts) return parts;
  if (e.note === '請假' || e.note === '不吃') return e.note;
  return '(未辨識)';
}
function entryBodyHtml(e) {
  const txt = entryBody(e);
  if (txt === '請假' || txt === '不吃') return \`<span style="color:#d4543a;font-weight:600">\${txt}</span>\`;
  return esc(txt);
}

function render() {
  const { zones, entries } = state;
  // 分組：每個啟用的 zone 一組；加「未分區」組
  const groups = new Map();
  // 未分區排最上面：管理員優先看到尚未辨識的人
  groups.set('__unassigned__', { zone: { name: '未分區', capacity: 0 }, list: [] });
  for (const z of zones) groups.set(z.name, { zone: z, list: [] });
  for (const e of entries) {
    const key = e.zone && groups.has(e.zone) ? e.zone : '__unassigned__';
    groups.get(key).list.push(e);
  }

  const board = document.getElementById('board');
  const parts = [];
  let totalZonesEnabled = zones.length;
  let filledZones = 0;
  for (const [k, g] of groups) {
    const isUnassigned = k === '__unassigned__';
    if (g.list.length === 0 && isUnassigned) continue; // 未分區沒人就不顯示
    const filled = g.list.length > 0;
    if (!isUnassigned && filled) filledZones++;
    const capNote = !isUnassigned && g.zone.capacity > 0
      ? (g.list.length >= g.zone.capacity ? \`<small>✓ \${g.list.length}/\${g.zone.capacity}</small>\` : \`<small>\${g.list.length}/\${g.zone.capacity}</small>\`)
      : (!isUnassigned && g.zone.capacity === 0 ? \`<small>\${g.list.length} 人（不限）</small>\` : '');
    const headerClass = isUnassigned ? 'zone none' : (g.list.length === 0 ? 'zone empty' : 'zone');
    const emptyTag = (!isUnassigned && g.list.length === 0) ? ' <span style="color:#bbb;font-style:italic;font-weight:400;">(未填)</span>' : '';
    const so = +g.zone.sort_order;
    const codeHtml = (so >= 100 && so < 1000) ? \`<span class="zone-code">\${String(so).padStart(4, '0')}</span>\` : '';
    parts.push(\`<h2 class="\${headerClass}"><span>\${codeHtml}\${esc(g.zone.name)}\${isUnassigned ? ' ⚠️' : ''}\${emptyTag}</span>\${capNote}</h2>\`);
    if (g.list.length === 0) continue;
    parts.push('<ul>' + g.list.map(e => {
      const price = e.price ? \`$\${e.price}\` : '';
      const noteShown = e.note && entryBody(e) !== '(未辨識)' ? \`（\${esc(e.note)}）\` : '';
      const idLine = isUnassigned ? \`<div class="uid-row">\${esc(e.user_id)}</div>\` : '';
      return \`<li><span class="who">\${esc(e.name)}\${idLine}</span><span class="body">\${entryBodyHtml(e)}\${noteShown}</span><span class="price">\${esc(price)}</span></li>\`;
    }).join('') + '</ul>');
  }

  const total = entries.reduce((s, e) => s + (e.price || 0), 0);
  if (total) parts.push(\`<div class="total">合計：$\${total}</div>\`);
  board.innerHTML = parts.join('');

  document.getElementById('statLine').textContent = \`共 \${entries.length} 筆・已填 \${filledZones}/\${totalZonesEnabled} 區\`;
}

async function poll() {
  try {
    const r = await fetch(location.pathname + '?json=1');
    if (!r.ok) return;
    const j = await r.json();
    state = j;
    render();
  } catch {}
}

render();
${closed ? '' : 'setInterval(poll, 5000);'}
</script>
</body>
</html>`;

  // JSON mode for polling
  const url = new URL(request.url);
  if (url.searchParams.get('json') === '1') {
    return Response.json(initData, { headers: { 'Cache-Control': 'no-store' } });
  }

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
