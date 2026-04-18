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
.admin-banner { background: #fff3e0; color: #b04a1a; border: 1px dashed #f0a058; border-radius: 6px; padding: 4px 8px; margin: 4px 0; font-size: 12px; }
.del-btn { margin-left: 6px; padding: 2px 6px; font-size: 12px; line-height: 1; border: 1px solid #d4543a; background: #fff; color: #d4543a; border-radius: 4px; cursor: pointer; }
.del-btn:hover { background: #d4543a; color: #fff; }
.del-btn:active { transform: scale(.94); }
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
.menu-card .items-list { margin-top: 6px; font-size: 13px; color: #666; max-height: 260px; overflow-y: auto; }
.menu-card .items-list .cat-row { margin: 4px 0 6px; }
.menu-card .items-list .cat-row > b { display: inline-block; margin-right: 6px; padding: 1px 6px; background: #2db87a; color: white; border-radius: 10px; font-size: 11px; font-weight: 600; }
.menu-card .items-list span { display: inline-block; padding: 6px 10px; margin: 3px; background: #eef; border-radius: 14px; min-height: 28px; }
.menu-card .items-list .item-chip { cursor: pointer; transition: background .15s, transform .08s; border: 1px solid transparent; user-select: none; }
.menu-card .items-list .item-chip:hover { background: #c8e5cf; }
.menu-card .items-list .item-chip:active { transform: scale(.96); background: #9fd4ad; }
.menu-card .items-list .item-chip .item-pick { color: #1e8a5c; font-weight: 700; font-size: 14px; }
@media (max-width: 480px) {
  .menu-card .items-list span { padding: 8px 12px; font-size: 14px; }
  .menu-card .items-list .item-chip .item-pick { font-size: 15px; }
}
.order-modal { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 998; display: flex; align-items: center; justify-content: center; }
.order-modal .box { background: #fff; border-radius: 12px; padding: 20px 20px 18px; max-width: 420px; width: 94vw; max-height: 92vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,.3); }
.order-modal h3 { margin: 0 0 14px; font-size: 17px; line-height: 1.3; }
.order-modal label { display: block; font-size: 13px; color: #555; margin: 12px 0 5px; font-weight: 600; }
.order-modal select, .order-modal input { width: 100%; padding: 12px 10px; font-size: 15px; border: 1px solid #bbb; border-radius: 8px; box-sizing: border-box; }
.order-modal .opt-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.order-modal .opt-grid button { flex: 1 0 auto; min-width: 64px; padding: 10px 8px; font-size: 14px; border-radius: 8px; border: 1.5px solid #ccc; background: #f8f8f8; color: #333; cursor: pointer; user-select: none; }
.order-modal .opt-grid button.active { background: #2db87a; color: white; border-color: #2db87a; font-weight: 600; }
.order-modal .opt-grid button:active { transform: scale(.96); }
.order-modal .row-btns { margin-top: 18px; display: flex; gap: 10px; }
.order-modal .row-btns button { flex: 1; padding: 12px; font-size: 15px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
.order-modal .row-btns button.primary { background: #2db87a; color: white; border-color: #2db87a; font-weight: 600; }
.order-modal .row-btns button.primary:disabled { background: #888; border-color: #888; cursor: wait; }
@media (prefers-color-scheme: dark) {
  .order-modal .box { background: #222; color: #eee; }
  .order-modal select, .order-modal input { background: #333; color: #eee; border-color: #555; }
  .order-modal button { background: #333; color: #eee; border-color: #555; }
}
.menu-card .items-list span b { font-weight: 700; margin-left: 2px; }
.menu-card .items-list .price-edit { color: #2db87a; cursor: pointer; text-decoration: underline dotted; margin-left: 2px; font-variant-numeric: tabular-nums; }
.menu-card .items-list .price-edit:hover { color: #249864; text-decoration: underline; }
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
<h1>${esc(task.task_name)} <span class="pill ${closed ? 'closed' : 'open'}">${statusLabel}</span><a class="admin-toggle" href="/admin/zones" target="_blank">🔧 管理員窗口</a>${closed ? '' : `<a class="admin-toggle" href="?admin=1" style="margin-right:8px">🗑 刪除模式</a>`}</h1>
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
      ${/飲料|飲品|茶|咖啡|手搖|冷飲|熱飲|奶茶|果汁|冰沙/.test(task.task_name || '') ? `
      <button data-dir="pure_tea">🍵 純茶</button>
      <button data-dir="milk_tea">🥛 奶類</button>
      <button data-dir="fruit">🍋 果味</button>
      <button data-dir="coffee">☕ 咖啡</button>
      <button data-dir="light_drink">💧 無糖低卡</button>
      <button data-dir="signature">⭐ 特色</button>
      <button data-dir="value">💰 C/P 值</button>
      <button data-dir="sweet">🍯 重甜香濃</button>
      ` : `
      <button data-dir="light">🥗 輕食</button>
      <button data-dir="no_beef">🚫 不吃牛</button>
      <button data-dir="vegan">🌱 素食</button>
      <button data-dir="staple">🍚 主食</button>
      <button data-dir="filling">🍱 飽足</button>
      <button data-dir="spicy">🌶 重口味</button>
      <button data-dir="value">💰 C/P 值</button>
      <button data-dir="healthy">💪 健康</button>
      `}
    </div>
    <div class="recommend-result" id="recommendResult"></div>
  </div>
</details>`}
${closed ? '' : `<div id="adminBanner" class="admin-banner" style="display:none">🔧 管理員模式：web 紀錄可刪除（× 按鈕）。<a href="?" style="color:#b04a1a">離開</a></div>`}
<div id="board"></div>

<script>
const INITIAL = ${JSON.stringify(initData)};
let state = INITIAL;
const IS_ADMIN = new URLSearchParams(location.search).get('admin') === '1';
if (IS_ADMIN) {
  document.body.classList.add('is-admin');
  const banner = document.getElementById('adminBanner');
  if (banner) banner.style.display = '';
}

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
      const isWeb = String(e.user_id || '').startsWith('web:');
      const delBtn = IS_ADMIN ? \`<button class="del-btn" data-uid="\${esc(e.user_id)}" data-real="\${isWeb ? '0' : '1'}" title="刪除此筆">×</button>\` : '';
      return \`<li><span class="who">\${esc(e.name)}\${idLine}</span><span class="body">\${entryBodyHtml(e)}\${noteShown}</span><span class="price">\${esc(price)}\${delBtn}</span></li>\`;
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

document.getElementById('board').addEventListener('click', async (ev) => {
  const b = ev.target.closest('.del-btn'); if (!b) return;
  const uid = b.dataset.uid; if (!uid) return;
  const entry = (state.entries || []).find(e => e.user_id === uid);
  const desc = entry ? (entry.name + ' / ' + (entry.data?.['品項'] || '(未辨識)')) : uid;
  const isReal = b.dataset.real === '1';
  const msg = (isReal ? '⚠️ 這是 LINE 真人紀錄，確定刪除？\\n' : '刪除這筆嗎？\\n') + desc;
  if (!confirm(msg)) return;
  b.disabled = true; b.textContent = '…';
  try {
    const r = await fetch('/api/t/${task.id}/quick-entry', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid }),
    });
    const j = await r.json();
    if (!r.ok) { alert('刪除失敗：' + (j.error || r.status)); b.disabled = false; b.textContent = '×'; return; }
    await poll();
  } catch (e) { alert('錯誤：' + e.message); b.disabled = false; b.textContent = '×'; }
});

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
      const sorted = byCat.get(cat).slice().sort((a,b) => (a.price ?? 99999) - (b.price ?? 99999));
      const its = sorted.map(it => {
        const cnt = orderCount.get(norm(it.name)) || 0;
        const priceLabel = it.price != null ? \`$\${it.price}\` : '—';
        const hot = cnt > 0 ? \` <b style="color:#d4543a">×\${cnt}</b>\` : '';
        return \`<span class="item-chip" data-name="\${esc(it.name)}" data-price="\${it.price ?? ''}" title="點擊下單到某一區"><b class="item-pick">\${esc(it.name)}</b> <a class="price-edit" data-name="\${esc(it.name)}" title="點擊修改價格">\${priceLabel}</a>\${hot}</span>\`;
      }).join('');
      return \`<div class="cat-row"><b>\${esc(cat)}</b>\${its}</div>\`;
    }).join('');
    document.getElementById('menuItems').innerHTML = sections;
    // 綁定價格編輯
    document.querySelectorAll('.price-edit').forEach(el => {
      el.addEventListener('click', async () => {
        const name = el.dataset.name;
        const current = el.textContent.replace(/[^\\d]/g, '') || '';
        const raw = prompt('修改「' + name + '」的價格（留空=未知，僅數字）：', current);
        if (raw === null) return;
        const val = raw.trim() === '' ? null : +raw.trim();
        if (val != null && (isNaN(val) || val < 0)) { alert('價格不合法'); return; }
        try {
          const r = await fetch('/api/menu/' + TASK_ID, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, price: val }),
          });
          if (!r.ok) { const j = await r.json().catch(() => ({})); alert('更新失敗：' + (j.error || r.status)); return; }
          loadMenu();
        } catch (e) { alert('錯誤：' + e.message); }
      });
    });
    // 品項 chip 點擊 → 開下單 modal
    document.querySelectorAll('.item-chip').forEach(chip => {
      chip.addEventListener('click', (ev) => {
        if (ev.target.closest('.price-edit')) return; // 點到價格修改區不觸發
        const name = chip.dataset.name;
        const price = chip.dataset.price === '' ? null : +chip.dataset.price;
        openOrderModal(name, price);
      });
    });
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
const REC_TTL_MS = 2 * 60 * 60 * 1000; // 本地快取 2 小時
function recCacheKey(dir) { return 'rec:' + TASK_ID + ':' + dir; }
function loadRecCache(dir) {
  try {
    const raw = localStorage.getItem(recCacheKey(dir));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.ts || (Date.now() - obj.ts) > REC_TTL_MS) return null;
    return obj.data;
  } catch { return null; }
}
function saveRecCache(dir, data) {
  try { localStorage.setItem(recCacheKey(dir), JSON.stringify({ ts: Date.now(), data })); } catch {}
}
// 首次初始化：把 localStorage 裡已推薦過的品項加進 recommendedSet（跨重整也能避免重複）
function primeRecommendedSet() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('rec:' + TASK_ID + ':')) continue;
      const obj = JSON.parse(localStorage.getItem(k) || '{}');
      if (!obj.ts || (Date.now() - obj.ts) > REC_TTL_MS) continue;
      for (const p of (obj.data?.picks || [])) recommendedSet.add(p.name);
    }
  } catch {}
}
primeRecommendedSet();

function renderRecommend(dir, j, fromCache) {
  const result = document.getElementById('recommendResult');
  const picks = (j.picks || []).map(p => {
    const price = (p.price != null) ? ' $' + p.price : '';
    return '<span class="pick"><b>' + esc(p.name) + price + '</b>' + (p.reason ? ' — ' + esc(p.reason) : '') + '</span>';
  }).join('');
  const note = j.note ? '<div class="note">' + esc(j.note) + '</div>' : '';
  const tag = fromCache ? ' (本地快取)' : (j.cached ? ' (伺服快取)' : '');
  result.innerHTML = '<div style="margin:4px 0;font-size:11px;color:#2db87a">' + esc(j.label || dir) + tag + '</div>' + (picks || '<span style="color:#888">沒有推薦</span>') + note;
}

async function fetchRecommend(btn, dir) {
  const result = document.getElementById('recommendResult');
  const cached = loadRecCache(dir);
  if (cached) { renderRecommend(dir, cached, true); return; }
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
    saveRecCache(dir, j);
    renderRecommend(dir, j, false);
  } catch (e) {
    result.innerHTML = '<span style="color:#d4543a">錯誤：' + esc(e.message) + '</span>';
  } finally {
    btn.classList.remove('busy'); btn.textContent = orig;
  }
}
document.querySelectorAll('.recommend-buttons button').forEach(b => {
  b.addEventListener('click', () => fetchRecommend(b, b.dataset.dir));
});

const TASK_NAME_RAW = ${JSON.stringify(task.task_name)};
const IS_DRINK_TASK = /飲料|飲品|茶|咖啡|手搖|冷飲|熱飲|奶茶|果汁|冰沙/.test(TASK_NAME_RAW);
const SWEET_OPTS = ['正常糖','少糖','半糖','微糖','無糖'];
const ICE_OPTS = ['正常冰','少冰','微冰','去冰','溫','熱'];
const LS_LAST_ZONE = 'lastZone:' + TASK_ID;

function openOrderModal(itemName, price) {
  const zones = (state.zones || []).filter(z => z.enabled !== 0);
  if (!zones.length) { alert('沒有可選的分區'); return; }
  const lastZone = localStorage.getItem(LS_LAST_ZONE) || '';
  const zoneOpts = zones.map(z => {
    const so = +z.sort_order;
    const code = (so >= 100 && so < 1000) ? String(so).padStart(4, '0') + ' ' : '';
    const sel = z.name === lastZone ? ' selected' : '';
    return '<option value="' + esc(z.name) + '"' + sel + '>' + esc(code + z.name) + '</option>';
  }).join('');
  const optBtns = (group, opts, defaultIdx) => '<div class="opt-grid" data-group="' + group + '">' +
    opts.map((o, i) => '<button type="button" data-val="' + esc(o) + '"' + (i === defaultIdx ? ' class="active"' : '') + '>' + esc(o) + '</button>').join('') +
    '</div>';
  const drinkRow = IS_DRINK_TASK ? (
    '<label>甜度</label>' + optBtns('sweet', SWEET_OPTS, 0) +
    '<label>冰塊</label>' + optBtns('ice', ICE_OPTS, 0)
  ) : '';
  // 衛生局：從花名冊挑會員，或選「非會員」
  const memberRow = '<div id="omMemberRow" style="display:none">' +
    '<label>是誰？（名單內請直接點；不在名單請選「非會員」並填名字）</label>' +
    '<div class="opt-grid" id="omRosterGrid"><span style="color:#888;font-size:12px">載入花名冊中…</span></div>' +
    '<div id="omNonMemberInput" style="display:none;margin-top:8px"><input id="omNonMemberName" maxlength="20" placeholder="請輸入非會員姓名"></div>' +
    '</div>' +
    '<div id="omZoneMemberHint" style="display:none;margin-top:6px;font-size:12px;color:#2db87a"></div>';
  const priceStr = price != null ? ' $' + price : '';
  const d = document.createElement('div');
  d.className = 'order-modal';
  d.innerHTML = '<div class="box">' +
    '<h3>下單：<span style="color:#2db87a">' + esc(itemName) + '</span>' + esc(priceStr) + '</h3>' +
    '<label>哪一區 / 誰</label><select id="omZone">' + zoneOpts + '</select>' +
    memberRow +
    drinkRow +
    '<label>備註（選填）</label><input id="omNote" maxlength="60" placeholder="例：不要香菜">' +
    '<div class="row-btns"><button id="omCancel">取消</button><button class="primary" id="omOk">送出</button></div>' +
    '</div>';
  document.body.appendChild(d);
  const close = () => d.remove();
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  // 選項按鈕：點擊切換 active（同組只能選一個）
  d.querySelectorAll('.opt-grid[data-group]').forEach(grid => {
    grid.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      grid.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
  });
  // 依區動態顯示/隱藏 會員挑選
  const memberRowEl = d.querySelector('#omMemberRow');
  const hintEl = d.querySelector('#omZoneMemberHint');
  const zoneSel = d.querySelector('#omZone');
  const rosterGrid = d.querySelector('#omRosterGrid');
  let rosterAll = null; // 全部花名冊（一次載入）
  let rosterGridRendered = false;
  async function ensureRosterLoaded() {
    if (rosterAll) return rosterAll;
    const r = await fetch('/api/roster');
    const j = await r.json();
    rosterAll = j.list || [];
    return rosterAll;
  }
  function renderHealthBureauGrid() {
    if (rosterGridRendered) return; rosterGridRendered = true;
    const list = (rosterAll || []).filter(m => m.zone === '衛生局');
    const btns = list.map(m => {
      const label = esc(m.real_name) + (m.title ? ' <small style="opacity:.7">' + esc(m.title) + '</small>' : '');
      return '<button type="button" data-val="' + esc(m.real_name) + '" data-title="' + esc(m.title || '') + '">' + label + '</button>';
    }).join('');
    rosterGrid.innerHTML = btns + '<button type="button" data-val="__non__" style="background:#fff3e0;color:#b04a1a;border-color:#f0a058">＋ 非會員（代點）</button>';
  }
  const nonMemberInput = d.querySelector('#omNonMemberInput');
  rosterGrid.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    rosterGrid.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const isNon = b.dataset.val === '__non__';
    nonMemberInput.style.display = isNon ? '' : 'none';
    if (isNon) setTimeout(() => d.querySelector('#omNonMemberName')?.focus(), 0);
  });
  const syncMemberRow = async () => {
    const z = zoneSel.value || '';
    const isHB = /衛生局/.test(z);
    memberRowEl.style.display = isHB ? '' : 'none';
    hintEl.style.display = 'none'; hintEl.textContent = '';
    try {
      await ensureRosterLoaded();
    } catch { rosterGrid.innerHTML = '<span style="color:#d4543a">花名冊載入失敗</span>'; return; }
    if (isHB) {
      renderHealthBureauGrid();
    } else {
      const hit = (rosterAll || []).find(m => m.zone === z);
      if (hit) {
        hintEl.textContent = '這筆會記給：' + hit.real_name + (hit.title ? '（' + hit.title + '）' : '');
        hintEl.style.display = '';
      }
    }
  };
  zoneSel.addEventListener('change', syncMemberRow);
  syncMemberRow();
  const getOpt = (group) => {
    const g = d.querySelector('.opt-grid[data-group="' + group + '"]');
    if (!g) return null;
    const a = g.querySelector('button.active');
    return a ? a.dataset.val : null;
  };
  d.querySelector('#omCancel').addEventListener('click', close);
  d.querySelector('#omOk').addEventListener('click', async () => {
    const okBtn = d.querySelector('#omOk');
    okBtn.disabled = true; okBtn.textContent = '送出中…';
    const zone = d.querySelector('#omZone').value;
    const sweet = IS_DRINK_TASK ? getOpt('sweet') : null;
    const ice = IS_DRINK_TASK ? getOpt('ice') : null;
    const note = d.querySelector('#omNote').value.trim() || null;
    let memberName = null, nonMemberName = null;
    if (/衛生局/.test(zone)) {
      const active = rosterGrid.querySelector('button.active');
      if (!active) { alert('請先選「是誰」'); okBtn.disabled = false; okBtn.textContent = '送出'; return; }
      if (active.dataset.val === '__non__') {
        nonMemberName = (d.querySelector('#omNonMemberName')?.value || '').trim();
        if (!nonMemberName) { alert('請填非會員姓名'); okBtn.disabled = false; okBtn.textContent = '送出'; return; }
      } else {
        memberName = active.dataset.val;
      }
    }
    try {
      const r = await fetch('/api/t/' + TASK_ID + '/quick-entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone, item: itemName, price, sweet, ice, note, memberName, nonMemberName }),
      });
      const j = await r.json();
      if (!r.ok) { alert('失敗：' + (j.error || r.status)); okBtn.disabled = false; okBtn.textContent = '送出'; return; }
      localStorage.setItem(LS_LAST_ZONE, zone);
      close();
      await poll();
    } catch (e) { alert('錯誤：' + e.message); okBtn.disabled = false; okBtn.textContent = '送出'; }
  });
}

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
