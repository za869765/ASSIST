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
.menu-card { margin: 8px 0 10px; padding: 8px 10px; border: 1px dashed #ccc6; border-radius: 8px; background: #fff1; }
.menu-card summary { cursor: pointer; font-weight: 600; font-size: 13px; color: #2e7fe6; user-select: none; }
.menu-card .menu-thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.menu-card .thumb { position: relative; width: 68px; height: 68px; border-radius: 6px; overflow: hidden; background: #eee; border: 1px solid #ccc4; }
.menu-card .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }
.menu-card .thumb button { position: absolute; top: 2px; right: 2px; background: rgba(0,0,0,.5); color: white; border: 0; border-radius: 50%; width: 18px; height: 18px; line-height: 18px; font-size: 11px; padding: 0; cursor: pointer; }
.menu-card .upload-row { margin-top: 6px; display: flex; gap: 6px; align-items: center; }
.menu-card .upload-row label { display: inline-block; padding: 4px 10px; border-radius: 6px; background: #2db87a; color: white; font-size: 12px; cursor: pointer; }
.menu-card .upload-row label.busy { background: #888; pointer-events: none; }
.menu-card .upload-row span { font-size: 11px; color: #888; }
.menu-card .items-list { margin-top: 6px; font-size: 11px; color: #666; max-height: 220px; overflow-y: auto; }
.menu-card .items-list .cat-row { margin: 4px 0 6px; }
.menu-card .items-list .cat-row > b { display: inline-block; margin-right: 6px; padding: 1px 6px; background: #2db87a; color: white; border-radius: 10px; font-size: 11px; font-weight: 600; }
.menu-card .items-list span { display: inline-block; padding: 1px 6px; margin: 1px; background: #eef; border-radius: 10px; }
.menu-card .items-list span b { font-weight: 700; margin-left: 2px; }
.menu-summary { margin-top: 6px; padding: 6px 8px; background: #fff3e0; border-radius: 6px; font-size: 12px; color: #b04a1a; }
.menu-summary:empty { display: none; }
.recommend-bar { margin-top: 8px; padding-top: 6px; border-top: 1px dashed #ccc6; }
.recommend-buttons { display: flex; flex-wrap: wrap; gap: 4px; }
.recommend-buttons button { padding: 4px 8px; font-size: 12px; border: 1px solid #2db87a; background: #fff1; color: #2db87a; border-radius: 12px; cursor: pointer; }
.recommend-buttons button:hover { background: #2db87a; color: white; }
.recommend-buttons button.busy { background: #888; color: white; border-color: #888; pointer-events: none; }
.recommend-result { margin-top: 6px; font-size: 12px; color: #333; }
.recommend-result:empty { display: none; }
.recommend-result .pick { display: block; padding: 4px 8px; margin: 3px 0; background: #e8f7ef; border-left: 3px solid #2db87a; border-radius: 4px; }
.recommend-result .pick b { color: #2db87a; }
.recommend-result .note { color: #888; font-size: 11px; margin-top: 4px; }
@media (prefers-color-scheme: dark) {
  .menu-card .items-list span { background: #333; }
  .menu-summary { background: #3a2e1f; color: #f0a058; }
  .recommend-result { color: #ccc; }
  .recommend-result .pick { background: #1f3a2a; }
}
.menu-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.9); display: flex; align-items: center; justify-content: center; z-index: 999; flex-direction: column; }
.menu-lightbox .stage { flex: 1; width: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; touch-action: pan-y; }
.menu-lightbox img { max-width: 95vw; max-height: 88vh; user-select: none; -webkit-user-drag: none; }
.menu-lightbox .nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,.2); color: white; border: 0; width: 48px; height: 48px; border-radius: 50%; font-size: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
.menu-lightbox .nav.prev { left: 12px; } .menu-lightbox .nav.next { right: 12px; }
.menu-lightbox .nav:hover { background: rgba(255,255,255,.35); }
.menu-lightbox .nav:disabled { opacity: .25; cursor: default; }
.menu-lightbox .close { position: absolute; top: 10px; right: 14px; background: rgba(255,255,255,.2); color: white; border: 0; width: 38px; height: 38px; border-radius: 50%; font-size: 20px; cursor: pointer; }
.menu-lightbox .counter { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); color: #fff; background: rgba(0,0,0,.4); padding: 4px 12px; border-radius: 12px; font-size: 13px; font-variant-numeric: tabular-nums; }
.menu-lightbox .strip { display: flex; gap: 6px; padding: 8px; overflow-x: auto; max-width: 100vw; background: rgba(0,0,0,.4); }
.menu-lightbox .strip img { width: 54px; height: 54px; object-fit: cover; border-radius: 4px; border: 2px solid transparent; cursor: pointer; max-width: none; max-height: none; opacity: .6; }
.menu-lightbox .strip img.active { border-color: #2db87a; opacity: 1; }
</style>
</head>
<body>
${tabs}
<h1>${esc(task.task_name)} <span class="pill ${closed ? 'closed' : 'open'}">${statusLabel}</span><a class="admin-toggle" href="/admin/zones" target="_blank">🔧 管理員窗口</a></h1>
<div class="meta">開始於 ${esc(task.started_at)}${closed ? `・結單於 ${esc(task.closed_at)}` : ''}・<span id="statLine">—</span>${closed ? '' : '・每 5 秒自動更新'}</div>

${closed ? '' : `<details class="menu-card" id="menuCard">
  <summary>📷 菜單（<span id="menuCount">0</span> 張／品項 <span id="menuItemCount">0</span>）</summary>
  <div class="menu-thumbs" id="menuThumbs"></div>
  <div class="upload-row">
    <label id="uploadLabel" for="menuFile">＋ 上傳菜單照</label>
    <input type="file" id="menuFile" accept="image/*" multiple style="display:none">
    <span id="uploadMsg">支援多張；任務結單後自動清除</span>
  </div>
  <div class="items-list" id="menuItems"></div>
  <div class="menu-summary" id="menuSummary"></div>
  <div class="recommend-bar">
    <div class="recommend-buttons">
      <button data-dir="light">🥗 輕食</button>
      <button data-dir="no_beef">🚫 不吃牛</button>
      <button data-dir="vegan">🌱 素食</button>
      <button data-dir="staple">🍚 主食</button>
      <button data-dir="filling">🍱 飽足</button>
      <button data-dir="spicy">🌶 重口味</button>
      <button data-dir="value">💰 C/P 值</button>
      <button data-dir="healthy">💪 健康</button>
    </div>
    <div class="recommend-result" id="recommendResult"></div>
  </div>
</details>`}
<div id="board"></div>

<script>
const INITIAL = ${JSON.stringify(initData)};
let state = INITIAL;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function entryBody(e) {
  const flat = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'object') return Object.values(v).map(flat).filter(Boolean).join('/');
    return String(v);
  };
  const parts = Object.values(e.data || {}).map(flat).filter(Boolean).join(' / ');
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
${closed ? '' : 'setInterval(async () => { await poll(); if (typeof loadMenu === "function") loadMenu(); }, 5000);'}

${closed ? '' : `
const TASK_ID = ${task.id};
async function loadMenu() {
  try {
    const r = await fetch('/api/menu/' + TASK_ID);
    if (!r.ok) return;
    const j = await r.json();
    const thumbs = document.getElementById('menuThumbs');
    thumbs.innerHTML = (j.photos || []).map(p => \`
      <div class="thumb" data-id="\${esc(p.id)}">
        <img src="\${esc(p.url)}" alt="menu">
        <button title="刪除" data-del="\${esc(p.id)}">×</button>
      </div>\`).join('');
    const photoUrls = (j.photos || []).map(p => p.url);
    thumbs.querySelectorAll('img').forEach((img, idx) => img.addEventListener('click', () => openLightbox(photoUrls, idx)));
    thumbs.querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); deletePhoto(b.dataset.del);
    }));
    document.getElementById('menuCount').textContent = (j.photos || []).length;
    document.getElementById('menuItemCount').textContent = (j.items || []).length;
    // 依「目前有多少人點」算熱度
    const norm = (s) => String(s || '').replace(/\\s+/g, '').toLowerCase();
    const orderCount = new Map();
    for (const e of (state.entries || [])) {
      const it = (e.data && e.data['品項']) || '';
      if (!it) continue;
      const k = norm(it);
      orderCount.set(k, (orderCount.get(k) || 0) + 1);
    }
    // 依分類分組
    const byCat = new Map();
    for (const it of (j.items || [])) {
      const cat = it.category || '其他';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    const CAT_ORDER = ['主食','便當','飯','麵','套餐','湯品','小菜','加料','飲料','甜點','其他'];
    const sortedCats = [...byCat.keys()].sort((a,b) => {
      const ia = CAT_ORDER.indexOf(a); const ib = CAT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const sections = sortedCats.map(cat => {
      const its = byCat.get(cat).map(it => {
        const cnt = orderCount.get(norm(it.name)) || 0;
        const price = it.price ? \` $\${it.price}\` : '';
        const hot = cnt > 0 ? \` <b style="color:#d4543a">×\${cnt}</b>\` : '';
        return \`<span>\${esc(it.name)}\${price}\${hot}</span>\`;
      }).join('');
      return \`<div class="cat-row"><b>\${esc(cat)}</b>\${its}</div>\`;
    }).join('');
    document.getElementById('menuItems').innerHTML = sections;
    // 目前點餐熱度摘要
    const top = [...orderCount.entries()]
      .sort((a,b) => b[1] - a[1]).slice(0, 5)
      .map(([k, n]) => {
        const it = (j.items || []).find(x => norm(x.name) === k);
        const name = it ? it.name : k;
        return \`\${esc(name)} ×\${n}\`;
      }).join('、');
    const sumEl = document.getElementById('menuSummary');
    if (sumEl) sumEl.textContent = top ? ('🔥 目前熱門：' + top) : '';
    if ((j.photos || []).length > 0) document.getElementById('menuCard').open = true;
  } catch (e) { console.error(e); }
}

async function uploadFiles(files) {
  const label = document.getElementById('uploadLabel');
  const msg = document.getElementById('uploadMsg');
  label.classList.add('busy'); label.textContent = '上傳中…';
  let done = 0;
  for (const f of files) {
    msg.textContent = \`上傳 \${++done}/\${files.length} …\`;
    const fd = new FormData(); fd.append('photo', f);
    try {
      const r = await fetch('/api/menu/' + TASK_ID, { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) msg.textContent = '失敗：' + (j.error || r.status);
    } catch (e) { msg.textContent = '失敗：' + e.message; }
  }
  label.classList.remove('busy'); label.textContent = '＋ 上傳菜單照';
  msg.textContent = '完成';
  await loadMenu();
  setTimeout(() => { msg.textContent = '支援多張；任務結單後自動清除'; }, 3000);
}

async function deletePhoto(id) {
  if (!confirm('刪掉這張菜單照嗎？')) return;
  try {
    await fetch('/api/menu/' + TASK_ID, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoId: id }),
    });
    await loadMenu();
  } catch (e) { alert('刪除失敗：' + e.message); }
}

function openLightbox(urls, startIdx) {
  if (!Array.isArray(urls) || !urls.length) return;
  let idx = Math.max(0, Math.min(startIdx | 0, urls.length - 1));
  const d = document.createElement('div'); d.className = 'menu-lightbox';
  d.innerHTML =
    '<button class="close" title="關閉">×</button>' +
    '<div class="counter"></div>' +
    '<button class="nav prev" title="上一張">‹</button>' +
    '<div class="stage"><img></div>' +
    '<button class="nav next" title="下一張">›</button>' +
    '<div class="strip">' + urls.map((u, i) => '<img data-i="' + i + '" src="' + esc(u) + '">').join('') + '</div>';
  const stage = d.querySelector('.stage img');
  const counter = d.querySelector('.counter');
  const prev = d.querySelector('.nav.prev');
  const next = d.querySelector('.nav.next');
  const strip = d.querySelector('.strip');
  function update() {
    stage.src = urls[idx];
    counter.textContent = (idx + 1) + ' / ' + urls.length;
    prev.disabled = idx === 0;
    next.disabled = idx === urls.length - 1;
    strip.querySelectorAll('img').forEach((t, i) => t.classList.toggle('active', i === idx));
    const active = strip.querySelector('img.active');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
  function go(n) { idx = (idx + n + urls.length) % urls.length; update(); }
  prev.addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
  next.addEventListener('click', (e) => { e.stopPropagation(); go(1); });
  strip.querySelectorAll('img').forEach(t => t.addEventListener('click', (e) => { e.stopPropagation(); idx = +t.dataset.i; update(); }));
  d.querySelector('.close').addEventListener('click', close);
  function close() { d.remove(); window.removeEventListener('keydown', onKey); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  }
  window.addEventListener('keydown', onKey);
  // 背景（stage 外）點擊關閉
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  // 觸控滑動切換
  let sx = 0, sy = 0, moved = false;
  stage.parentElement.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; moved = false; }, { passive: true });
  stage.parentElement.addEventListener('touchmove', (e) => { if (Math.abs(e.touches[0].clientX - sx) > 10) moved = true; }, { passive: true });
  stage.parentElement.addEventListener('touchend', (e) => {
    if (!moved) return;
    const dx = (e.changedTouches[0].clientX - sx);
    const dy = (e.changedTouches[0].clientY - sy);
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  });
  document.body.appendChild(d);
  update();
}

document.getElementById('menuFile').addEventListener('change', (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (files.length) uploadFiles(files);
});

const recommendedSet = new Set(); // 跨 direction 累計已推薦過的品項，避免重複
async function fetchRecommend(btn, dir) {
  const result = document.getElementById('recommendResult');
  btn.classList.add('busy'); const orig = btn.textContent; btn.textContent = '思考中…';
  try {
    const exclude = [...recommendedSet].slice(-30).join(',');
    const r = await fetch('/api/menu/' + TASK_ID + '/recommend?dir=' + encodeURIComponent(dir)
      + (exclude ? '&exclude=' + encodeURIComponent(exclude) : ''));
    const j = await r.json();
    if (!r.ok) {
      result.innerHTML = '<span style="color:#d4543a">' + esc(j.note || j.error || '失敗') + '</span>';
      return;
    }
    for (const p of (j.picks || [])) recommendedSet.add(p.name);
    const picks = (j.picks || []).map(p => {
      const price = (p.price != null) ? ' $' + p.price : '';
      return '<span class="pick"><b>' + esc(p.name) + price + '</b>' + (p.reason ? ' — ' + esc(p.reason) : '') + '</span>';
    }).join('');
    const note = j.note ? '<div class="note">' + esc(j.note) + '</div>' : '';
    result.innerHTML = '<div style="margin:4px 0;font-size:11px;color:#2db87a">' + esc(j.label || dir) + (j.cached ? ' (快取)' : '') + '</div>' + (picks || '<span style="color:#888">沒有推薦</span>') + note;
  } catch (e) {
    result.innerHTML = '<span style="color:#d4543a">錯誤：' + esc(e.message) + '</span>';
  } finally {
    btn.classList.remove('busy'); btn.textContent = orig;
  }
}
document.querySelectorAll('.recommend-buttons button').forEach(b => {
  b.addEventListener('click', () => fetchRecommend(b, b.dataset.dir));
});

loadMenu();
`}
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
