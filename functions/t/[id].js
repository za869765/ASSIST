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
    task: { id: task.id, name: task.task_name, mode: task.mode || 'free' },
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
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(task.task_name)}｜即時點單</title>
<style>
/* =============================================================
   ASSIST 看板 · 尊榮優化版（手機優先）
   — 手機 ≤390px 為基準設計，桌面僅做寬度限制
   ============================================================= */

@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Noto+Serif+TC:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');

:root {
  color-scheme: dark;
  --gold:        #C9A961;
  --gold-dim:    #A38848;
  --gold-bright: #E8C979;
  --gold-glow:   rgba(201,169,97,.5);
  --wine:        #B08D7A;
  --jade:        #7FA88C;
  --bg:          #241E15;
  --bg-elev:     #32291C;
  --bg-card:     rgba(50,41,28,.7);
  --line:        rgba(201,169,97,.38);
  --line-soft:   rgba(201,169,97,.22);
  --text:        #F5EEDB;
  --text-muted:  rgba(245,238,219,.75);
  --text-dim:    rgba(245,238,219,.55);
  --danger:      #C27070;

  --f-zh: 'Noto Serif TC', 'PingFang TC', 'Microsoft JhengHei', serif;
  --f-en: 'Cormorant Garamond', 'EB Garamond', serif;
  --f-ui: 'Inter', -apple-system, 'PingFang TC', sans-serif;
  --f-num: 'Cormorant Garamond', ui-serif, Georgia, serif;

  --safe-bottom: env(safe-area-inset-bottom, 0px);
}

* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

html, body {
  margin: 0; padding: 0;
  background: var(--bg);
  background-image:
    radial-gradient(ellipse 80% 50% at 50% 0%, rgba(201,169,97,.06), transparent 60%),
    radial-gradient(ellipse 60% 40% at 50% 100%, rgba(176,141,122,.04), transparent 60%);
  color: var(--text);
  font-family: var(--f-ui);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

body {
  max-width: 440px;
  margin: 0 auto;
  padding: 14px 16px calc(100px + var(--safe-bottom));
}

/* ===== 1. 頂部標題 ===== */
h1 {
  margin: 0;
  font-family: var(--f-zh);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--text);
  line-height: 1.3;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 8px 0 0;
}

/* EN 襯線副標用 pill + admin-toggle */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-family: var(--f-en);
  font-style: italic;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .1em;
  text-transform: uppercase;
  vertical-align: middle;
}
.pill.open {
  background: transparent;
  color: var(--gold);
  border: 1px solid var(--gold-dim);
}
.pill.open::before {
  content: '';
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--gold);
  box-shadow: 0 0 8px var(--gold);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity:.6; } 50% { opacity:1; } }
.pill.closed { background: transparent; color: var(--text-muted); border: 1px solid var(--text-dim); }

/* Admin 工具列 — 獨立成一排的圖示按鈕 */
.admin-toggle {
  font-family: var(--f-ui);
  font-size: 12px;
  color: var(--text-muted);
  text-decoration: none;
  letter-spacing: .02em;
  padding: 6px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  transition: all .2s;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.admin-toggle:hover, .admin-toggle:active {
  color: var(--gold);
  border-color: var(--gold-dim);
  background: rgba(201,169,97,.06);
}

/* meta 列 — 細金線分隔 */
.meta {
  font-family: var(--f-en);
  font-style: italic;
  font-size: 12px;
  color: var(--text-muted);
  margin: 10px 0 16px;
  padding: 10px 0;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
  letter-spacing: .04em;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  align-items: center;
}
.meta::before { content: '◆'; color: var(--gold); font-size: 8px; }
.meta #statLine { color: var(--gold-dim); font-weight: 500; }

/* admin 工具列容器 */
.admin-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 0;
}

/* ===== 2. Tab 列 ===== */
.tabs {
  display: flex;
  gap: 6px;
  margin: 0 0 12px;
  overflow-x: auto;
  padding: 2px 0;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  flex: 1;
  min-width: 90px;
  padding: 13px 12px;
  text-decoration: none;
  color: var(--text-muted);
  background: var(--bg-card);
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  white-space: nowrap;
  font-family: var(--f-zh);
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  letter-spacing: .04em;
  transition: all .25s;
  backdrop-filter: blur(8px);
  position: relative;
}
.tab::after {
  content: '';
  position: absolute;
  left: 50%; bottom: -1px;
  width: 0; height: 2px;
  background: var(--gold);
  transition: all .3s;
  transform: translateX(-50%);
}
.tab:hover { color: var(--gold); border-color: var(--gold-dim); }
.tab:hover::after { width: 60%; }
.tab.active {
  color: var(--gold);
  background: var(--bg-elev);
  border-color: var(--gold);
  font-weight: 600;
}
.tab.active::after { width: 100%; }

/* ===== 3. 菜單卡（details） ===== */
.menu-card {
  margin: 0 0 16px;
  padding: 16px 16px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-card);
  backdrop-filter: blur(8px);
  position: relative;
}
.menu-card::before {
  content: '';
  position: absolute;
  top: 0; left: 12px; right: 12px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
  opacity: 0;
  transition: opacity .4s;
}
.menu-card[open]::before { opacity: 1; }

.menu-card summary {
  cursor: pointer;
  font-family: var(--f-zh);
  font-weight: 500;
  font-size: 15px;
  color: var(--gold);
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 10px;
  letter-spacing: .04em;
  min-height: 44px;
}
.menu-card summary::-webkit-details-marker { display: none; }
.menu-card summary::before {
  content: '◈';
  color: var(--gold);
  font-size: 14px;
}
.menu-card summary::after {
  content: '+';
  margin-left: auto;
  font-family: var(--f-en);
  font-size: 24px;
  font-weight: 300;
  color: var(--gold);
  transition: transform .3s;
  line-height: 1;
  opacity: .7;
}
.menu-card[open] summary::after { transform: rotate(45deg); }

.menu-card .menu-thumbs {
  display: flex; flex-wrap: wrap; gap: 8px;
  margin-top: 14px;
}
.menu-card .thumb {
  position: relative;
  width: 76px; height: 76px;
  border-radius: 2px;
  overflow: hidden;
  background: #1a1510;
  border: 1px solid var(--line);
}
.menu-card .thumb img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  cursor: zoom-in;
}
.menu-card .thumb button {
  position: absolute; top: 4px; right: 4px;
  background: rgba(10,8,6,.85);
  color: var(--gold);
  border: 1px solid var(--gold-dim);
  border-radius: 50%;
  width: 22px; height: 22px;
  line-height: 20px;
  font-size: 12px;
  padding: 0; cursor: pointer;
  font-family: var(--f-en);
}

.menu-card .upload-row {
  margin-top: 14px;
  display: flex; gap: 10px; align-items: center;
  padding-top: 14px;
  border-top: 1px dashed var(--line-soft);
  flex-wrap: wrap;
}
.menu-card .upload-row label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: 2px;
  background: transparent;
  color: var(--gold);
  font-family: var(--f-zh);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: .06em;
  cursor: pointer;
  border: 1px solid var(--gold);
  transition: all .25s;
  min-height: 44px;
}
.menu-card .upload-row label:hover,
.menu-card .upload-row label:active {
  background: var(--gold);
  color: var(--bg);
}
.menu-card .upload-row label.busy {
  background: var(--text-dim);
  color: var(--bg);
  border-color: var(--text-dim);
  pointer-events: none;
}
.menu-card .upload-row span {
  font-family: var(--f-en);
  font-style: italic;
  font-size: 12px;
  color: var(--text-muted);
}

/* ===== items-list：chip 系統 ===== */
.menu-card .items-list {
  margin-top: 16px;
  font-size: 14px;
  color: var(--text);
  max-height: 420px;
  overflow-y: auto;
  padding-right: 2px;
  -webkit-overflow-scrolling: touch;
}
.menu-card .items-list::-webkit-scrollbar { width: 3px; }
.menu-card .items-list::-webkit-scrollbar-thumb { background: var(--gold-dim); border-radius: 2px; }

.menu-card .items-list .cat-row {
  margin: 0 0 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line-soft);
}
.menu-card .items-list .cat-row:last-child {
  border-bottom: 0;
  padding-bottom: 0;
  margin-bottom: 0;
}
.menu-card .items-list .cat-row > b {
  display: block;
  margin: 0 0 10px;
  background: transparent;
  color: var(--gold);
  font-family: var(--f-zh);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .2em;
  padding-left: 16px;
  position: relative;
}
.menu-card .items-list .cat-row > b::before {
  content: '';
  position: absolute;
  left: 0; top: 50%;
  width: 10px; height: 1px;
  background: var(--gold);
}

.menu-card .items-list span {
  display: inline-flex;
  align-items: center;
  padding: 12px 14px;
  margin: 4px 4px 4px 0;
  background: rgba(26,21,16,.5);
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  min-height: 44px;
  font-family: var(--f-zh);
  transition: all .2s;
}
.menu-card .items-list .item-chip {
  cursor: pointer;
  user-select: none;
  position: relative;
  gap: 6px;
}
.menu-card .items-list .item-chip:hover {
  border-color: var(--gold);
  background: rgba(201,169,97,.08);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(201,169,97,.2);
}
.menu-card .items-list .item-chip:active { transform: translateY(0) scale(.98); }

.menu-card .items-list .item-chip.leave-chip {
  border-color: rgba(194,112,112,.35);
  background: rgba(194,112,112,.08);
}
.menu-card .items-list .item-chip.leave-chip:hover {
  border-color: var(--danger);
  background: rgba(194,112,112,.14);
  box-shadow: 0 4px 14px rgba(194,112,112,.22);
}
.menu-card .items-list .item-chip.leave-chip .item-pick { color: var(--danger); }

.menu-card .items-list .item-chip .item-pick {
  color: var(--gold);
  font-weight: 500;
  font-size: 14.5px;
  letter-spacing: .02em;
}
.menu-card .items-list .item-chip .price-edit {
  color: var(--wine);
  font-family: var(--f-num);
  font-size: 15px;
  font-weight: 500;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
  letter-spacing: .04em;
}
.menu-card .items-list span b { font-weight: 600; }

/* 熱度標記 */
.menu-card .items-list .item-chip b[style*="d4543a"],
.menu-card .items-list .item-chip .hot-count {
  color: var(--wine) !important;
  font-family: var(--f-num);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: .04em;
}

/* AI 推薦命中 */
.menu-card .items-list .item-chip.rec-hit {
  background: linear-gradient(135deg, rgba(201,169,97,.25) 0%, rgba(232,201,121,.15) 100%);
  border-color: var(--gold);
  box-shadow: 0 0 0 2px var(--gold), 0 0 28px rgba(201,169,97,.55);
  transform: translateY(-2px);
  animation: recPop .5s cubic-bezier(.34,1.56,.64,1);
  z-index: 2;
}
.menu-card .items-list .item-chip.rec-hit::before {
  content: '';
  position: absolute;
  top: -5px; right: -5px;
  width: 10px; height: 10px;
  background: var(--gold);
  border-radius: 50%;
  box-shadow: 0 0 14px var(--gold);
  animation: dotPulse 1.4s ease-in-out infinite;
}
.menu-card .items-list .item-chip.rec-hit .item-pick { color: #FFF4D4; font-weight: 600; }
.menu-card .items-list .item-chip.rec-hit .price-edit { color: var(--gold-bright); }
@keyframes recPop { 0% { transform: scale(.7); } 60% { transform: scale(1.08) translateY(-4px); } 100% { transform: translateY(-2px); } }
@keyframes dotPulse { 0%,100% { transform: scale(1); opacity:.9; } 50% { transform: scale(1.5); opacity:.4; } }

/* 新增菜單外品項的 chip */
.menu-card .items-list .item-chip.add-custom {
  background: rgba(176,141,122,.08) !important;
  border: 1px dashed var(--wine) !important;
}
.menu-card .items-list .item-chip.add-custom .item-pick {
  color: var(--wine) !important;
}

/* 編輯模式（同時可改名稱與價格） */
body.is-edit-price .menu-card .items-list .item-chip {
  cursor: pointer;
}
body.is-edit-price .menu-card .items-list .item-chip .item-pick {
  padding: 2px 8px;
  border-radius: 2px;
  border: 1px dashed rgba(201,169,97,.6);
  background: rgba(201,169,97,.1);
}
body.is-edit-price .menu-card .items-list .price-edit {
  cursor: pointer;
  pointer-events: auto;
  background: rgba(201,169,97,.18);
  padding: 2px 10px;
  border-radius: 2px;
  border: 1px dashed var(--gold);
  color: var(--gold-bright);
  text-decoration: none;
}
body.is-edit-price .menu-card .items-list .price-edit:hover,
body.is-edit-price .menu-card .items-list .price-edit:active,
body.is-edit-price .menu-card .items-list .item-chip .item-pick:hover {
  background: var(--gold); color: var(--bg);
}
body.is-edit-price h1::after {
  content: '編輯模式';
  display: inline-flex;
  align-items: center;
  font-family: var(--f-en);
  font-style: italic;
  font-size: 12px;
  background: var(--gold);
  color: var(--bg);
  padding: 3px 10px;
  border-radius: 2px;
  letter-spacing: .1em;
  font-weight: 500;
}

.menu-summary {
  margin-top: 12px;
  padding: 10px 14px;
  background: rgba(176,141,122,.08);
  border-left: 2px solid var(--wine);
  border-radius: 0 2px 2px 0;
  font-family: var(--f-zh);
  font-size: 13px;
  color: var(--wine);
  letter-spacing: .02em;
  line-height: 1.5;
}
.menu-summary:empty { display: none; }

/* ===== 4. AI 推薦 bar ===== */
.recommend-bar {
  margin-top: 18px;
  padding: 16px 0 4px;
  border-top: 1px solid var(--line-soft);
  position: relative;
}
.recommend-bar::before {
  content: 'AI Sommelier · 點方向為您挑選';
  display: block;
  font-family: var(--f-en);
  font-style: italic;
  font-size: 13px;
  font-weight: 500;
  color: var(--gold);
  margin-bottom: 12px;
  letter-spacing: .08em;
}
.recommend-buttons {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.recommend-buttons button {
  padding: 13px 14px;
  font-family: var(--f-zh);
  font-size: 14px;
  font-weight: 500;
  border: 1px solid var(--gold-dim);
  background: rgba(26,21,16,.5);
  color: var(--gold);
  border-radius: 2px;
  cursor: pointer;
  letter-spacing: .04em;
  transition: all .2s;
  min-height: 48px;
  backdrop-filter: blur(4px);
}
.recommend-buttons button:hover,
.recommend-buttons button:active {
  background: var(--gold);
  color: var(--bg);
  border-color: var(--gold);
}
.recommend-buttons button.busy {
  background: var(--text-dim); color: var(--bg); border-color: var(--text-dim);
  pointer-events: none;
}

.recommend-result {
  margin-top: 12px;
  font-size: 13px;
  color: var(--text);
  font-family: var(--f-zh);
}
.recommend-result:empty { display: none; }
.recommend-result .pick {
  display: block;
  padding: 10px 14px;
  margin: 6px 0;
  background: rgba(201,169,97,.08);
  border-left: 2px solid var(--gold);
  border-radius: 0 2px 2px 0;
  line-height: 1.5;
}
.recommend-result .pick b {
  color: var(--gold);
  font-weight: 600;
  letter-spacing: .02em;
}
.recommend-result .note {
  color: var(--text-muted);
  font-family: var(--f-en);
  font-style: italic;
  font-size: 12px;
  margin-top: 6px;
  letter-spacing: .02em;
}

/* ===== 5. 看板（zones + entries）===== */
h2.zone {
  font-family: var(--f-zh);
  font-size: 14px;
  font-weight: 600;
  margin: 20px 0 8px;
  padding: 10px 0 10px 14px;
  color: var(--gold);
  background: transparent;
  border-left: 2px solid var(--gold);
  border-bottom: 1px solid var(--line-soft);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
  letter-spacing: .06em;
  transition: all .25s;
}
h2.zone:first-of-type { margin-top: 14px; }
h2.zone:hover { background: rgba(201,169,97,.05); padding-left: 18px; }
h2.zone.none {
  color: var(--wine);
  border-left-color: var(--wine);
  background: rgba(176,141,122,.05);
}
h2.zone.empty {
  color: var(--text-dim);
  font-weight: 400;
  border-left-color: var(--text-dim);
}
h2.zone small {
  color: var(--text-muted);
  font-family: var(--f-en);
  font-style: italic;
  font-weight: 400;
  font-size: 12.5px;
  letter-spacing: .04em;
}
.zone-code {
  color: var(--gold-dim);
  font-family: var(--f-num);
  font-variant-numeric: tabular-nums;
  margin-right: 8px;
  font-weight: 500;
  font-size: 12.5px;
  letter-spacing: .12em;
}

.in-office-tag {
  display: inline-flex;
  align-items: center;
  font-family: var(--f-en);
  font-style: italic;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--jade);
  border: 1px solid var(--jade);
  padding: 1px 8px;
  border-radius: 2px;
  margin-left: 8px;
  vertical-align: middle;
  letter-spacing: .08em;
  background: rgba(127,168,140,.08);
  text-transform: uppercase;
}

/* entry list */
ul { list-style: none; padding: 0; margin: 0 0 4px; }
li {
  display: grid;
  grid-template-columns: 92px 1fr auto;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  background: var(--bg-card);
  align-items: center;
  margin-bottom: 4px;
  transition: all .2s;
  backdrop-filter: blur(4px);
}
li:hover {
  background: rgba(26,21,16,.85);
  border-color: var(--line);
  transform: translateX(2px);
}

.uid-row {
  font-family: var(--f-en);
  font-size: 10px;
  color: var(--text-dim);
  word-break: break-all;
  font-weight: 400;
  font-style: italic;
  margin-top: 3px;
  letter-spacing: .02em;
}
.who {
  font-family: var(--f-zh);
  font-weight: 500;
  font-size: 14px;
  color: var(--gold);
  letter-spacing: .04em;
  line-height: 1.3;
}
.body {
  font-family: var(--f-zh);
  word-break: break-all;
  font-size: 13.5px;
  color: var(--text);
  line-height: 1.45;
  letter-spacing: .01em;
}
.price {
  color: var(--gold);
  font-family: var(--f-num);
  font-variant-numeric: tabular-nums;
  text-align: right;
  font-size: 17px;
  font-weight: 500;
  letter-spacing: .04em;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
  white-space: nowrap;
}
.price:empty { display: none; }

.del-btn {
  padding: 0;
  line-height: 1;
  border: 1px solid rgba(194,112,112,.4);
  background: transparent;
  color: var(--danger);
  border-radius: 50%;
  width: 28px; height: 28px;
  cursor: pointer;
  font-family: var(--f-en);
  font-size: 15px;
  transition: all .2s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.del-btn:hover, .del-btn:active {
  background: var(--danger); color: var(--bg); border-color: var(--danger);
}

/* Total — 金框尊榮結算 */
.total {
  text-align: right;
  margin-top: 20px;
  padding: 20px 22px;
  background: linear-gradient(135deg, var(--bg-elev) 0%, #000 100%);
  color: var(--gold);
  border: 1px solid var(--gold);
  border-radius: 2px;
  font-family: var(--f-num);
  font-size: 26px;
  font-weight: 500;
  letter-spacing: .06em;
  font-variant-numeric: tabular-nums;
  position: relative;
  box-shadow: 0 0 40px rgba(201,169,97,.25),
              inset 0 0 30px rgba(201,169,97,.06);
}
.total::before {
  content: 'Grand Total';
  display: block;
  font-family: var(--f-en);
  font-style: italic;
  font-size: 11px;
  letter-spacing: .32em;
  color: rgba(201,169,97,.55);
  margin-bottom: 4px;
  text-transform: uppercase;
  font-weight: 500;
}
.total::after {
  content: '';
  position: absolute;
  top: 0; left: 20px; right: 20px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}

/* admin banner */
.admin-banner {
  background: rgba(194,112,112,.08);
  color: var(--danger);
  border: 1px solid rgba(194,112,112,.3);
  border-left-width: 2px;
  border-radius: 2px;
  padding: 10px 14px;
  margin: 10px 0 14px;
  font-family: var(--f-zh);
  font-size: 13px;
  letter-spacing: .02em;
  line-height: 1.5;
}
.admin-banner a {
  color: var(--danger);
  font-weight: 600;
  text-decoration: underline;
  margin-left: 6px;
}

/* ===== 6. Lightbox ===== */
.menu-lightbox {
  position: fixed; inset: 0;
  background: rgba(5,4,3,.96);
  display: flex; align-items: center; justify-content: center;
  z-index: 9999;
  flex-direction: column;
  backdrop-filter: blur(16px);
  animation: fadeIn .25s ease-out;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.menu-lightbox .stage {
  flex: 1; width: 100%;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; touch-action: pan-y;
}
.menu-lightbox img { max-width: 95vw; max-height: 82vh; user-select: none; -webkit-user-drag: none; }
.menu-lightbox .nav {
  position: absolute; top: 50%;
  transform: translateY(-50%);
  background: transparent;
  color: var(--gold);
  border: 1px solid var(--gold-dim);
  width: 48px; height: 48px;
  border-radius: 50%;
  font-family: var(--f-en);
  font-size: 26px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all .2s;
  backdrop-filter: blur(8px);
}
.menu-lightbox .nav.prev { left: 14px; }
.menu-lightbox .nav.next { right: 14px; }
.menu-lightbox .nav:hover,
.menu-lightbox .nav:active { background: var(--gold); color: var(--bg); }
.menu-lightbox .nav:disabled { opacity: .2; cursor: default; }

.menu-lightbox .close {
  position: absolute;
  top: calc(14px + env(safe-area-inset-top, 0px));
  right: 18px;
  background: transparent;
  color: var(--gold);
  border: 1px solid var(--gold-dim);
  width: 40px; height: 40px;
  border-radius: 50%;
  font-size: 18px;
  cursor: pointer;
  font-family: var(--f-en);
}
.menu-lightbox .close:hover,
.menu-lightbox .close:active { background: var(--gold); color: var(--bg); }

.menu-lightbox .counter {
  position: absolute;
  top: calc(18px + env(safe-area-inset-top, 0px));
  left: 50%;
  transform: translateX(-50%);
  color: var(--gold);
  background: rgba(10,8,6,.6);
  border: 1px solid var(--gold-dim);
  padding: 5px 16px;
  border-radius: 2px;
  font-family: var(--f-en);
  font-style: italic;
  font-size: 13px;
  letter-spacing: .12em;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(8px);
}

.menu-lightbox .strip {
  display: flex; gap: 8px; padding: 14px;
  padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px));
  overflow-x: auto;
  max-width: 100vw;
  background: rgba(10,8,6,.9);
  border-top: 1px solid var(--line);
}
.menu-lightbox .strip img {
  width: 60px; height: 60px;
  object-fit: cover;
  border-radius: 2px;
  border: 1px solid transparent;
  cursor: pointer;
  max-width: none; max-height: none;
  opacity: .4;
  transition: all .2s;
  flex-shrink: 0;
}
.menu-lightbox .strip img.active { border-color: var(--gold); opacity: 1; }
.menu-lightbox .strip img:hover { opacity: .85; }

/* ===== 7. 下單 modal — 手機 Bottom Sheet ===== */
.order-modal {
  position: fixed; inset: 0;
  background: rgba(5,4,3,.7);
  backdrop-filter: blur(10px);
  z-index: 998;
  display: flex;
  align-items: flex-end; /* 底部對齊 */
  justify-content: center;
  animation: modalFade .25s ease-out;
  padding: 0;
}
@keyframes modalFade { from { opacity: 0; backdrop-filter: blur(0); } to { opacity: 1; backdrop-filter: blur(10px); } }

.order-modal .box {
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 18px 18px 0 0;
  padding: 10px 22px calc(22px + env(safe-area-inset-bottom, 0px));
  max-width: 480px;
  width: 100%;
  max-height: 92vh;
  overflow-y: auto;
  box-shadow: 0 -20px 60px rgba(0,0,0,.6), 0 -1px 0 var(--gold);
  border-top: 1px solid var(--gold);
  position: relative;
  animation: sheetUp .35s cubic-bezier(.34,1.56,.64,1);
}
.order-modal .box::before {
  content: '';
  display: block;
  width: 40px; height: 4px;
  background: var(--gold-dim);
  border-radius: 999px;
  margin: 0 auto 16px;
  opacity: .5;
}
@keyframes sheetUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }

.order-modal.closing { animation: modalFadeOut .2s ease-in forwards; }
.order-modal.closing .box { animation: sheetDown .25s ease-in forwards; }
@keyframes modalFadeOut { to { opacity: 0; } }
@keyframes sheetDown { to { opacity: 0; transform: translateY(40px); } }

.order-modal h3 {
  margin: 0 0 18px;
  font-family: var(--f-zh);
  font-size: 19px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--text);
  letter-spacing: .04em;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line-soft);
}
.order-modal h3 span { color: var(--gold); font-weight: 600; }

.order-modal label {
  display: block;
  font-family: var(--f-en);
  font-style: italic;
  font-size: 12px;
  color: var(--gold-dim);
  margin: 16px 0 8px;
  font-weight: 500;
  letter-spacing: .18em;
  text-transform: uppercase;
}

.order-modal select,
.order-modal input {
  width: 100%;
  padding: 14px 14px;
  font-family: var(--f-zh);
  font-size: 16px; /* iOS 防放大 */
  border: 1px solid var(--line);
  border-radius: 2px;
  box-sizing: border-box;
  background: rgba(10,8,6,.6);
  color: var(--text);
  transition: border-color .2s;
  -webkit-appearance: none;
  appearance: none;
}
.order-modal select {
  background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23C9A961' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 16px center;
  padding-right: 40px;
}
.order-modal select:focus,
.order-modal input:focus {
  outline: none;
  border-color: var(--gold);
  box-shadow: 0 0 0 3px rgba(201,169,97,.15);
}

.order-modal .opt-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.order-modal .opt-grid button {
  flex: 1 0 calc(33.333% - 6px);
  min-width: 0;
  padding: 12px 10px;
  font-family: var(--f-zh);
  font-size: 14px;
  border-radius: 2px;
  border: 1px solid var(--line);
  background: rgba(10,8,6,.5);
  color: var(--text);
  cursor: pointer;
  user-select: none;
  transition: all .2s;
  min-height: 46px;
  letter-spacing: .04em;
}
.order-modal .opt-grid button:hover { border-color: var(--gold-dim); }
.order-modal .opt-grid button.active {
  background: var(--gold);
  color: var(--bg);
  border-color: var(--gold);
  font-weight: 600;
}
.order-modal .opt-grid button:active { transform: scale(.96); }

/* 會員挑選 grid */
#omRosterGrid { flex-direction: column; display: flex; gap: 6px; }
#omRosterGrid button {
  flex: 1 1 auto;
  text-align: left;
  padding: 12px 14px;
}
#omRosterGrid button small { opacity: .6; font-size: 12px; margin-left: 6px; }
#omZoneMemberHint {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(127,168,140,.08);
  border-left: 2px solid var(--jade);
  color: var(--jade) !important;
  font-family: var(--f-zh);
  font-size: 12.5px;
  border-radius: 0 2px 2px 0;
}

.order-modal .row-btns {
  margin-top: 22px;
  display: flex;
  gap: 10px;
  padding-top: 18px;
  border-top: 1px solid var(--line-soft);
}
.order-modal .row-btns button {
  flex: 1;
  padding: 15px;
  font-family: var(--f-zh);
  font-size: 15px;
  border-radius: 2px;
  border: 1px solid var(--line);
  background: rgba(10,8,6,.5);
  color: var(--text);
  cursor: pointer;
  letter-spacing: .06em;
  transition: all .2s;
  min-height: 50px;
}
.order-modal .row-btns button:hover { border-color: var(--gold-dim); }
.order-modal .row-btns button.primary {
  background: var(--gold);
  color: var(--bg);
  border-color: var(--gold);
  font-weight: 700;
  letter-spacing: .12em;
  position: relative;
}
.order-modal .row-btns button.primary::before {
  content: '✦';
  margin-right: 8px;
}
.order-modal .row-btns button.primary:hover,
.order-modal .row-btns button.primary:active {
  background: var(--gold-bright);
  border-color: var(--gold-bright);
}
.order-modal .row-btns button.primary:disabled {
  background: var(--text-dim);
  border-color: var(--text-dim);
  color: var(--bg);
  cursor: wait;
}

/* Price modal 清除按鈕 */
.order-modal #pmClear {
  color: var(--danger) !important;
  border-color: rgba(194,112,112,.4) !important;
}
.order-modal #pmClear:hover,
.order-modal #pmClear:active {
  background: var(--danger) !important;
  color: var(--bg) !important;
  border-color: var(--danger) !important;
}

/* ===== 8. 點單成功彈窗 ===== */
.success-overlay {
  position: fixed; inset: 0;
  background: radial-gradient(circle at center, rgba(201,169,97,.18) 0%, rgba(5,4,3,.92) 70%);
  backdrop-filter: blur(14px);
  z-index: 10001;
  display: flex; align-items: center; justify-content: center;
  animation: fadeIn .3s ease-out;
  cursor: pointer;
  padding: 24px;
}
.success-overlay.closing { animation: fadeOut .3s ease-in forwards; }
@keyframes fadeOut { to { opacity: 0; } }

.success-card {
  background: linear-gradient(180deg, var(--bg-elev) 0%, #0a0806 100%);
  border-radius: 4px;
  padding: 40px 32px 32px;
  max-width: 360px;
  width: 100%;
  text-align: center;
  box-shadow: 0 30px 80px rgba(0,0,0,.7),
              0 0 80px rgba(201,169,97,.35);
  border: 1px solid var(--gold);
  position: relative;
  animation: successPop .5s cubic-bezier(.34,1.56,.64,1);
  overflow: hidden;
}
.success-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}
.success-card::after {
  content: '';
  position: absolute;
  inset: 8px;
  border: 1px solid rgba(201,169,97,.22);
  border-radius: 2px;
  pointer-events: none;
}
.success-overlay.closing .success-card { animation: popOut .25s ease-in forwards; }
@keyframes successPop { from { opacity: 0; transform: scale(.9) translateY(12px); } to { opacity: 1; transform: scale(1); } }
@keyframes popOut { to { opacity: 0; transform: scale(.95); } }

.success-card > * { position: relative; z-index: 1; }

.success-check {
  width: 72px; height: 72px;
  margin: 0 auto 20px;
  border-radius: 50%;
  background: transparent;
  border: 1.5px solid var(--gold);
  display: flex; align-items: center; justify-content: center;
  color: var(--gold);
  font-family: var(--f-en);
  font-size: 40px;
  font-weight: 300;
  position: relative;
  animation: checkDraw .5s ease-out .1s backwards;
}
.success-check::before {
  content: '';
  position: absolute;
  inset: -10px;
  border: 1px solid rgba(201,169,97,.3);
  border-radius: 50%;
  animation: ring 1.6s ease-out infinite;
}
.success-check::after {
  content: '';
  position: absolute;
  inset: -20px;
  border: 1px solid rgba(201,169,97,.15);
  border-radius: 50%;
  animation: ring 1.6s ease-out .4s infinite;
}
@keyframes checkDraw { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: scale(1); } }
@keyframes ring { 0% { transform: scale(.85); opacity: .8; } 100% { transform: scale(1.3); opacity: 0; } }

.success-title {
  font-family: var(--f-en);
  font-style: italic;
  font-size: 13px;
  font-weight: 500;
  color: var(--gold-dim);
  margin: 0 0 6px;
  letter-spacing: .38em;
  text-transform: uppercase;
  animation: titleSlide .4s ease-out .2s backwards;
}
.success-title::before, .success-title::after {
  content: '—';
  color: var(--gold);
  margin: 0 10px;
  opacity: .6;
}
@keyframes titleSlide { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

.success-item {
  font-family: var(--f-zh);
  font-size: 26px;
  font-weight: 600;
  color: var(--text);
  margin: 12px 0 16px;
  letter-spacing: .04em;
  word-break: break-word;
  line-height: 1.3;
  animation: itemZoom .45s cubic-bezier(.34,1.56,.64,1) .3s backwards;
}
@keyframes itemZoom { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }

.success-details {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin: 14px 0 4px;
  animation: fadeIn .4s ease-out .45s backwards;
}

.success-detail {
  background: transparent;
  color: var(--text);
  padding: 5px 12px;
  border-radius: 2px;
  font-family: var(--f-zh);
  font-size: 12.5px;
  font-weight: 500;
  border: 1px solid var(--line);
  letter-spacing: .04em;
}

.success-price {
  font-family: var(--f-num);
  font-size: 32px;
  font-weight: 500;
  color: var(--gold);
  margin-top: 16px;
  letter-spacing: .06em;
  font-variant-numeric: tabular-nums;
  animation: fadeIn .4s ease-out .55s backwards;
}
.success-price::before {
  content: 'NT$';
  font-family: var(--f-en);
  font-style: italic;
  font-size: 14px;
  color: var(--gold-dim);
  margin-right: 8px;
  letter-spacing: .16em;
  vertical-align: middle;
  font-weight: 500;
}

.success-hint {
  font-family: var(--f-en);
  font-style: italic;
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 22px;
  letter-spacing: .1em;
  animation: fadeIn .4s ease-out .8s backwards;
}

.success-spark {
  position: absolute;
  color: var(--gold);
  font-size: 16px;
  pointer-events: none;
  animation: sparkFly 1.6s ease-out forwards;
  opacity: 0;
  text-shadow: 0 0 10px var(--gold-glow);
}
@keyframes sparkFly {
  0% { opacity: 1; transform: translate(0,0) scale(0) rotate(0); }
  30% { opacity: 1; transform: translate(var(--dx), var(--dy)) scale(1.1) rotate(180deg); }
  100% { opacity: 0; transform: translate(calc(var(--dx)*1.6), calc(var(--dy)*1.6)) scale(.4) rotate(360deg); }
}

/* ===== 9. Toast ===== */
.luxe-toast {
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%,-50%);
  background: var(--bg-elev);
  color: var(--gold);
  padding: 14px 28px;
  border-radius: 2px;
  border: 1px solid var(--gold);
  font-family: var(--f-zh);
  font-weight: 500;
  font-size: 14px;
  letter-spacing: .06em;
  z-index: 10000;
  box-shadow: 0 20px 60px rgba(0,0,0,.6), 0 0 40px rgba(201,169,97,.25);
  pointer-events: none;
  animation: toastFloat 1.4s ease-out forwards;
}
@keyframes toastFloat {
  0% { opacity: 0; transform: translate(-50%,-50%) scale(.85); }
  15% { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%,-180%); }
}

/* ===== 11. 手機精細調整（≤390px）===== */
@media (max-width: 390px) {
  body { padding: 12px 14px calc(88px + var(--safe-bottom)); }
  h1 { font-size: 20px; }
  .pill { font-size: 11px; padding: 2px 9px; }
  .admin-toggle { font-size: 11.5px; padding: 5px 8px; }
  .tab { padding: 12px 10px; font-size: 13.5px; min-width: 80px; }
  .meta { font-size: 11.5px; }
  h2.zone { font-size: 13.5px; padding: 9px 0 9px 12px; margin: 16px 0 6px; }
  h2.zone small { font-size: 12px; }
  li { grid-template-columns: 84px 1fr auto; gap: 10px; padding: 11px 12px; }
  .who { font-size: 13.5px; }
  .body { font-size: 13px; }
  .price { font-size: 16px; }
  .total { font-size: 22px; padding: 18px; }
  .total::before { font-size: 10.5px; }
  .menu-card { padding: 14px; }
  .menu-card summary { font-size: 14.5px; }
  .recommend-buttons { gap: 6px; }
  .recommend-buttons button { font-size: 13.5px; padding: 12px; }
  .success-card { padding: 32px 24px 26px; }
  .success-check { width: 64px; height: 64px; font-size: 34px; }
  .success-item { font-size: 22px; }
  .success-price { font-size: 28px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
  }
}

/* ===== 12. 12 色 Luxe 變體（原 JS 套 body.luxe.t-* 時切換）===== */
/* 注意：此設計預設「就是尊榮黑金」，body.luxe class 加上去後才啟用 12 色變體色票 */
body.luxe.t-green  { --gold:#8FBC9C; --wine:#BCDCBC; --jade:#B0D0B0; --bg:#1A3826; --bg-elev:#234830; --text:#E5F4E8; }
body.luxe.t-purple { --gold:#BEA8DC; --wine:#D0B4DC; --jade:#BEB4DC; --bg:#2E2845; --bg-elev:#3A3454; --text:#EEE4F5; }
body.luxe.t-red    { --gold:#DCA09B; --wine:#ECBCB0; --jade:#E4AFA4; --bg:#3E2020; --bg-elev:#4E2C2C; --text:#F7E4E0; }
body.luxe.t-blue   { --gold:#9CBCDC; --wine:#B0C8DC; --jade:#A4BCDC; --bg:#1C3048; --bg-elev:#26405C; --text:#E4ECF7; }
body.luxe.t-orange { --gold:#DCAC72; --wine:#ECBE8C; --jade:#E4B078; --bg:#3A2414; --bg-elev:#4A301E; --text:#F7E8D5; }
body.luxe.t-starry { --gold:#CCDCEC; --wine:#CCD4EC; --jade:#B0BCE4; --bg:#121C36; --bg-elev:#1D2A48; --text:#E4EAF5; }
body.luxe.t-fairy  { --gold:#DCB0D0; --wine:#ECBCD8; --jade:#B0D8EC; --bg:#30203A; --bg-elev:#3E2C4C; --text:#F4E2EE; }
body.luxe.t-royal  { --gold:#DCAC5C; --wine:#CC9272; --jade:#C09B64; --bg:#30202A; --bg-elev:#3E2C38; --text:#F7E8CA; }
body.luxe.t-aurora { --gold:#B0DCC4; --wine:#BCB0DC; --jade:#90CCDC; --bg:#1A2C44; --bg-elev:#243C58; --text:#E4F4EC; }
body.luxe.t-sakura { --gold:#DCAEB8; --wine:#ECBCC4; --jade:#E4BCC8; --bg:#35202A; --bg-elev:#442C38; --text:#F7E2E8; }
body.luxe.t-cyber  { --gold:#B0DCEC; --wine:#DCA4DC; --jade:#BCE4A0; --bg:#10142E; --bg-elev:#1C204A; --text:#DCECE4; }
body.luxe.t-green  html, body.luxe.t-green  { background: var(--bg); }
body.luxe.t-purple html, body.luxe.t-purple { background: var(--bg); }
body.luxe.t-red    html, body.luxe.t-red    { background: var(--bg); }
body.luxe.t-blue   html, body.luxe.t-blue   { background: var(--bg); }
body.luxe.t-orange html, body.luxe.t-orange { background: var(--bg); }
body.luxe.t-starry html, body.luxe.t-starry { background: var(--bg); }
body.luxe.t-fairy  html, body.luxe.t-fairy  { background: var(--bg); }
body.luxe.t-royal  html, body.luxe.t-royal  { background: var(--bg); }
body.luxe.t-aurora html, body.luxe.t-aurora { background: var(--bg); }
body.luxe.t-sakura html, body.luxe.t-sakura { background: var(--bg); }
body.luxe.t-cyber  html, body.luxe.t-cyber  { background: var(--bg); }

/* Luxe 粒子層（原 JS 會建立） */
.particles {
  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;
}
.particle {
  position: absolute;
  width: 3px; height: 3px;
  background: var(--gold);
  border-radius: 50%;
  opacity: .25;
  animation: floatUp 25s infinite;
  box-shadow: 0 0 6px var(--gold);
}
.particle.particle-emoji {
  width: auto; height: auto;
  background: transparent;
  border-radius: 0;
  opacity: .45;
  font-size: 18px;
  line-height: 1;
  box-shadow: none;
}
@keyframes floatUp {
  0% { transform: translateY(0) translateX(0); opacity: 0; }
  10%,90% { opacity: .25; }
  100% { transform: translateY(-100vh) translateX(50px); opacity: 0; }
}

/* 所有內容相對粒子提高一層 */
h1, .meta, .admin-row, .tabs, .menu-card, #board,
.admin-banner { position: relative; z-index: 1; }
</style>
</head>
<body>
${tabs}

<h1>
  ${esc(task.task_name)}
  <span class="pill ${closed ? 'closed' : 'open'}">${statusLabel}</span>
</h1>

<div class="meta">
  <span>開始於 ${esc(task.started_at)}${closed ? `・結單於 ${esc(task.closed_at)}` : ''}</span>
  <span id="statLine">—</span>
  ${closed ? '' : '<span>自動更新 · 5s</span>'}
  <span style="opacity:.6">v1.0.6</span>
</div>

<div class="admin-row">
  <a class="admin-toggle" href="/admin/zones" target="_blank">🔧 管理員</a>
  ${closed ? '' : `
  <a class="admin-toggle" href="?admin=1">🗑 刪除模式</a>
  <a class="admin-toggle" href="?edit=1">📝 編輯模式</a>
  <a class="admin-toggle" href="/api/t/${task.id}/export">📊 匯出 XLSX</a>
  `}
</div>

${closed ? '' : `<label class="menu-mode-toggle" id="menuModeToggle" style="display:flex;align-items:center;gap:8px;margin:8px 0;padding:8px 12px;background:rgba(184,134,11,.08);border:1px solid rgba(184,134,11,.3);border-radius:6px;font-size:14px;cursor:pointer;user-select:none">
  <input type="checkbox" id="menuModeChk" style="width:16px;height:16px;cursor:pointer">
  <span>📋 開啟菜單模式（勾選後展開菜單區，可上傳菜單照／管理品項）</span>
</label>
<details class="menu-card" id="menuCard" style="display:none">
  <summary>菜單（<span id="menuCount">0</span> 張／品項 <span id="menuItemCount">0</span>）</summary>
  <div class="menu-thumbs" id="menuThumbs"></div>
  <div class="upload-row">
    <label id="uploadLabel" for="menuFile">＋ 上傳菜單照</label>
    <input type="file" id="menuFile" accept="image/*" multiple style="display:none">
    <span id="uploadMsg">支援多張；任務結單後自動清除</span>
  </div>
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
</details>
<div class="items-list" id="menuItems" style="margin:10px 0"></div>`}

${closed ? '' : `<div id="adminBanner" class="admin-banner" style="display:none">🔧 管理員模式：web 紀錄可刪除（× 按鈕）。<a href="?">離開</a></div>`}
${closed ? '' : `<div id="editPriceBanner" class="admin-banner" style="display:none">📝 編輯模式：點「品項名稱」或「價格」可以改（OCR 亂碼可在這裡修正）。<a href="?">離開</a></div>`}

<div id="board"></div>

<div class="particles" id="luxeParticles" aria-hidden="true"></div>

<script>
// XSS 防護：JSON.stringify 後再把 `<` `-->` `]]>` 與 LS/PS 換成 \u 跳脫字串，避免從 <script> 逃出
const INITIAL = ${JSON.stringify(initData).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e').replace(/\]\]>/g, ']]\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};
let state = INITIAL;

// LUXE 主題切換（localStorage 記憶：開關 + 6 色）
const THEMES = ['t-green', 't-purple', 't-red', 't-blue', 't-orange', 't-starry', 't-fairy', 't-royal', 't-aurora', 't-sakura', 't-cyber'];
const THEME_PARTICLES = {
  't-green':  ['◆','◇','❖'],
  't-purple': ['✦','✧','⟡'],
  't-red':    ['◆','❂','❦'],
  't-blue':   ['◇','❖','⟐'],
  't-orange': ['◆','❋','✦'],
  't-starry': ['✦','✧','⋆','✯'],
  't-fairy':  ['✦','❋','✧','❀'],
  't-royal':  ['❖','✦','⟡','◆'],
  't-aurora': ['✧','✦','◇'],
  't-sakura': ['❀','✿','❁'],
  't-cyber':  ['◆','▲','◈','⬢'],
};
// 以 task.id 做 hash：同一任務永遠同主題；不同任務各自不同
function pickThemeFor(key) {
  let h = 0;
  const s = String(key || 'default');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return THEMES[Math.abs(h) % THEMES.length];
}
function applyTheme(name) {
  THEMES.forEach(t => document.body.classList.remove(t));
  if (name) document.body.classList.add(name);
  const emojis = THEME_PARTICLES[name];
  document.querySelectorAll('#luxeParticles .particle').forEach((p, i) => {
    if (emojis) {
      p.classList.add('particle-emoji');
      p.textContent = emojis[i % emojis.length];
    } else {
      p.classList.remove('particle-emoji');
      p.textContent = '';
    }
  });
}
function initLuxe() {
  document.body.classList.add('luxe');
  const p = document.getElementById('luxeParticles');
  if (p && !p.dataset.ready) {
    p.dataset.ready = '1';
    const count = window.matchMedia('(max-width: 480px)').matches ? 12 : 30;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'particle';
      el.style.left = Math.random() * 100 + '%';
      el.style.top = Math.random() * 100 + '%';
      el.style.animationDelay = (Math.random() * 20) + 's';
      el.style.animationDuration = (15 + Math.random() * 20) + 's';
      p.appendChild(el);
    }
  }
  applyTheme(pickThemeFor(INITIAL?.task?.id));
}
initLuxe();

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'luxe-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1400);
}

function showSuccessPopup({ item, zone, name, sweet, ice, note, price }) {
  const d = document.createElement('div');
  d.className = 'success-overlay';
  const details = [];
  if (zone) details.push('📍 ' + zone);
  if (name) details.push('👤 ' + name);
  if (sweet) details.push('🍬 ' + sweet);
  if (ice) details.push('🧊 ' + ice);
  if (note) details.push('📝 ' + note);
  const priceHtml = price ? \`<div class="success-price">＄\${price}</div>\` : '';
  d.innerHTML = \`
    <div class="success-card" role="dialog" aria-label="點單成功">
      <div class="success-check">✓</div>
      <h2 class="success-title">點單成功！</h2>
      <div class="success-item">\${item.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div>
      \${details.length ? \`<div class="success-details">\${details.map(t => \`<span class="success-detail">\${t.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</span>\`).join('')}</div>\` : ''}
      \${priceHtml}
      <div class="success-hint">點畫面任何位置關閉</div>
    </div>
  \`;
  document.body.appendChild(d);
  // 星星爆發（8 顆）
  const card = d.querySelector('.success-card');
  const sparks = ['⭐','✨','💫','🎉','🌟','✨','💖','🎊'];
  for (let i = 0; i < 8; i++) {
    const s = document.createElement('span');
    s.className = 'success-spark';
    s.textContent = sparks[i];
    const angle = (i / 8) * Math.PI * 2;
    const dist = 140 + Math.random() * 60;
    s.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
    s.style.left = '50%'; s.style.top = '30%';
    s.style.animationDelay = (i * 0.04) + 's';
    card.appendChild(s);
  }
  const close = () => { d.classList.add('closing'); setTimeout(() => d.remove(), 350); };
  d.addEventListener('click', close);
  // 2.6 秒後自動關閉
  setTimeout(() => { if (d.parentNode) close(); }, 2600);
}

const IS_ADMIN = new URLSearchParams(location.search).get('admin') === '1';
const IS_EDIT_PRICE = new URLSearchParams(location.search).get('edit') === '1';
if (IS_ADMIN) {
  document.body.classList.add('is-admin');
  const banner = document.getElementById('adminBanner');
  if (banner) banner.style.display = '';
}
if (IS_EDIT_PRICE) {
  document.body.classList.add('is-edit-price');
  const eb = document.getElementById('editPriceBanner');
  if (eb) eb.style.display = '';
}

// 記住目前 AI 推薦命中，loadMenu 重新渲染後還原
let currentRecHits = new Set();

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
    const IN_OFFICE_ZONES = ['楠西區', '南化區', '左鎮區', '新市區'];
    const inOfficeTag = IN_OFFICE_ZONES.includes(g.zone.name)
      ? ' <span class="in-office-tag" title="該所人員駐點衛生局">🏢 在局</span>' : '';
    const so = +g.zone.sort_order;
    const codeHtml = (so >= 100 && so < 1000) ? \`<span class="zone-code">\${String(so).padStart(4, '0')}</span>\` : '';
    parts.push(\`<h2 class="\${headerClass}"><span>\${codeHtml}\${esc(g.zone.name)}\${inOfficeTag}\${isUnassigned ? ' ⚠️' : ''}\${emptyTag}</span>\${capNote}</h2>\`);
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

// 菜單模式 toggle：勾選=menu、取消=free；同時連動 menuCard 顯示
(function initMenuModeToggle() {
  const chk = document.getElementById('menuModeChk');
  const card = document.getElementById('menuCard');
  if (!chk || !card) return;
  const initOn = !!(state && state.task && state.task.mode === 'menu');
  chk.checked = initOn;
  card.style.display = initOn ? '' : 'none';
  chk.addEventListener('change', async () => {
    const target = chk.checked ? 'menu' : 'free';
    let pass = sessionStorage.getItem('adminPass') || '';
    if (!pass) {
      pass = (window.prompt('請輸入管理員密碼') || '').trim();
      if (!pass) { chk.checked = !chk.checked; return; }
      sessionStorage.setItem('adminPass', pass);
    }
    try {
      const r = await fetch('/api/t/' + TASK_ID + '/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Pass': pass },
        body: JSON.stringify({ mode: target }),
      });
      if (r.status === 401) {
        sessionStorage.removeItem('adminPass');
        alert('密碼錯誤');
        chk.checked = !chk.checked;
        return;
      }
      if (!r.ok) {
        alert('切換失敗：' + r.status);
        chk.checked = !chk.checked;
        return;
      }
      if (state && state.task) state.task.mode = target;
      card.style.display = chk.checked ? '' : 'none';
      if (typeof loadMenu === 'function') loadMenu();
    } catch (e) {
      alert('錯誤：' + e.message);
      chk.checked = !chk.checked;
    }
  });
})();

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
    // 無菜單 fallback
    // 無菜單模式（mode=free）一律走 fallback chips（葷/素/請假），即使 DB 還有舊菜單品項
    const isMenuMode = state && state.task && state.task.mode === 'menu';
    const hasItems = isMenuMode && (j.items || []).length > 0;
    const recBar = document.querySelector('.recommend-bar');
    const leaveRow = '<div class="cat-row" style="margin-top:8px"><span class="item-chip leave-chip" data-name="__leave__"><b class="item-pick">📝 請假</b></span></div>';
    if (!hasItems && IS_DRINK_TASK) {
      // 飲料類強制要有菜單，沒上傳就擋住（請假仍可）
      document.getElementById('menuItems').innerHTML =
        '<div style="padding:10px;background:rgba(240,160,88,.08);border:1px dashed rgba(240,160,88,.4);border-radius:6px;color:var(--wine);font-size:13px">' +
        '🥤 飲料類任務必須先上傳菜單才能點單。<br>請先用上方「＋ 上傳菜單照」上傳菜單照片。' +
        '</div>' + leaveRow;
      if (recBar) recBar.style.display = 'none';
    } else if (!hasItems) {
      document.getElementById('menuItems').innerHTML =
        '<div class="cat-row"><b>便當</b>' +
        '<span class="item-chip" data-name="葷食便當" data-price=""><b class="item-pick">葷食便當</b></span>' +
        '<span class="item-chip" data-name="素食便當" data-price=""><b class="item-pick">素食便當</b></span>' +
        '</div>' +
        leaveRow +
        '<div style="margin-top:6px;font-size:11px;color:var(--text-dim)">（尚未上傳菜單；可直接點上面快速下單）</div>';
      if (recBar) recBar.style.display = 'none';
    } else {
      // 菜單模式也允許新增菜單外品項，並加上請假按鈕
      const extraBtn = '<div class="cat-row" style="margin-top:8px"><span class="item-chip add-custom" data-name="__custom__" style="background:rgba(240,160,88,.1);border-color:rgba(240,160,88,.4)"><b class="item-pick" style="color:var(--wine)">＋ 新增品項（菜單外）</b></span></div>';
      document.getElementById('menuItems').innerHTML = sections + extraBtn + leaveRow;
      if (recBar) recBar.style.display = '';
    }
    // 還原 AI 推薦高亮
    if (currentRecHits.size) highlightChips([...currentRecHits]);
    // 品項 chip 點擊：編輯模式→開編輯 modal；一般→開下單 modal
    document.querySelectorAll('.item-chip').forEach(chip => {
      chip.addEventListener('click', (ev) => {
        if (chip.dataset.name === '__custom__') {
          openCustomModal();
          return;
        }
        if (chip.dataset.name === '__leave__') {
          openLeaveModal();
          return;
        }
        const name = chip.dataset.name;
        const price = chip.dataset.price === '' ? null : +chip.dataset.price;
        if (IS_EDIT_PRICE) {
          // 編輯模式：無論點名稱或價格都開同一個 modal（名稱+價格一起改）
          if (chip.classList.contains('add-custom')) return; // 新增品項鈕不能改
          openEditItemModal(name, price);
          return;
        }
        if (ev.target.closest('.price-edit')) return; // 下單模式：點到價格不觸發
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

function highlightChips(names, opts) {
  const norm = (s) => String(s || '').replace(/\\s+/g, '').toLowerCase();
  const list = Array.isArray(names) ? names : [];
  const scroll = opts && opts.scroll;
  currentRecHits = new Set(list); // 記住，loadMenu 之後可還原
  const targets = new Set(list.map(norm));
  const chips = document.querySelectorAll('.item-chip');
  let first = null;
  chips.forEach(c => {
    const hit = targets.has(norm(c.dataset.name));
    c.classList.remove('rec-hit');
    if (hit) {
      void c.offsetWidth;
      c.classList.add('rec-hit');
      if (!first) first = c;
    }
  });
  if (scroll && first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function openEditItemModal(itemName, currentPrice) {
  const d = document.createElement('div');
  d.className = 'order-modal';
  d.innerHTML = \`
    <div class="box" style="max-width:380px">
      <h3>📝 修改品項</h3>
      <label>品項名稱（OCR 亂碼可在這裡改）</label>
      <input id="pmName" type="text" maxlength="60" value="\${esc(itemName)}" autofocus>
      <label>金額（留空＝未知、僅數字）</label>
      <input id="pmVal" type="number" inputmode="numeric" min="0" max="9999" value="\${esc(currentPrice ?? '')}">
      <div class="row-btns">
        <button type="button" id="pmCancel">取消</button>
        <button type="button" id="pmClear" style="background:rgba(194,112,112,.12);color:var(--danger);border-color:rgba(194,112,112,.4)">清除價格</button>
        <button type="button" id="pmOk" class="primary">儲存</button>
      </div>
    </div>
  \`;
  document.body.appendChild(d);
  const close = () => { d.classList.add('closing'); setTimeout(() => d.remove(), 200); };
  const nameInput = d.querySelector('#pmName');
  const priceInput = d.querySelector('#pmVal');
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  d.querySelector('#pmCancel').addEventListener('click', close);
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  const submit = async (payload) => {
    try {
      const r = await fetch('/api/menu/' + TASK_ID, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert('更新失敗：' + (j.error || r.status)); return; }
      close();
      loadMenu();
    } catch (e) { alert('錯誤：' + e.message); }
  };
  d.querySelector('#pmOk').addEventListener('click', () => {
    const newName = nameInput.value.trim();
    if (!newName) { alert('品項名稱不可為空'); return; }
    const raw = priceInput.value.trim();
    const priceVal = raw === '' ? null : +raw;
    if (priceVal != null && (isNaN(priceVal) || priceVal < 0)) { alert('價格不合法'); return; }
    submit({ name: itemName, newName, price: priceVal });
  });
  d.querySelector('#pmClear').addEventListener('click', () => {
    priceInput.value = '';
    priceInput.focus();
  });
  [nameInput, priceInput].forEach(el => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') d.querySelector('#pmOk').click();
    if (e.key === 'Escape') close();
  }));
}

function renderRecommend(dir, j, fromCache) {
  const result = document.getElementById('recommendResult');
  const picks = (j.picks || []).map(p => {
    const price = (p.price != null) ? ' $' + p.price : '';
    return '<span class="pick"><b>' + esc(p.name) + price + '</b>' + (p.reason ? ' — ' + esc(p.reason) : '') + '</span>';
  }).join('');
  const note = j.note ? '<div class="note">' + esc(j.note) + '</div>' : '';
  const tag = fromCache ? ' (本地快取)' : (j.cached ? ' (伺服快取)' : '');
  result.innerHTML = '<div style="margin:4px 0;font-size:11px;color:#2db87a">' + esc(j.label || dir) + tag + '</div>' + (picks || '<span style="color:#888">沒有推薦</span>') + note;
  highlightChips((j.picks || []).map(p => p.name), { scroll: true });
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

function openCustomModal() {
  const d = document.createElement('div');
  d.className = 'order-modal';
  d.innerHTML = '<div class="box">' +
    '<h3>＋ 新增品項（菜單外）</h3>' +
    '<label>品項名稱</label><input id="cmName" maxlength="40" placeholder="例：地瓜湯" autocomplete="off">' +
    '<label>價格（選填）</label><input id="cmPrice" type="number" inputmode="numeric" placeholder="留空表示未知">' +
    '<div class="row-btns"><button id="cmCancel">取消</button><button class="primary" id="cmOk">下一步</button></div>' +
    '</div>';
  document.body.appendChild(d);
  setTimeout(() => d.querySelector('#cmName')?.focus(), 50);
  const close = () => { d.classList.add('closing'); setTimeout(() => d.remove(), 200); };
  d.addEventListener('click', (ev) => { if (ev.target === d) close(); });
  d.querySelector('#cmCancel').addEventListener('click', close);
  d.querySelector('#cmOk').addEventListener('click', () => {
    const name = d.querySelector('#cmName').value.trim();
    if (!name) { alert('請輸入品項名稱'); return; }
    const priceRaw = d.querySelector('#cmPrice').value.trim();
    const price = priceRaw === '' ? null : +priceRaw;
    if (price != null && (isNaN(price) || price < 0)) { alert('價格不合法'); return; }
    close();
    openOrderModal(name, price, true);
  });
}

function openOrderModal(itemName, price, isCustom) {
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
  const close = () => { d.classList.add('closing'); setTimeout(() => d.remove(), 200); };
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
    // 檢查是否已有點餐：同人再點要問「加點 / 更改」
    const existing = findExistingEntry(zone, memberName, nonMemberName);
    let additive = false;
    if (existing) {
      const choice = await askAddOrReplace(existing, itemName, price);
      if (!choice) { okBtn.disabled = false; okBtn.textContent = '送出'; return; }
      additive = (choice === 'add');
    }
    try {
      const r = await fetch('/api/t/' + TASK_ID + '/quick-entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone, item: itemName, price, sweet, ice, note, memberName, nonMemberName, custom: !!isCustom, additive }),
      });
      const j = await r.json();
      if (!r.ok) { alert('失敗：' + (j.error || r.status)); okBtn.disabled = false; okBtn.textContent = '送出'; return; }
      localStorage.setItem(LS_LAST_ZONE, zone);
      close();
      showSuccessPopup({
        item: itemName,
        zone,
        name: memberName || nonMemberName || null,
        sweet, ice, note, price,
        additive,
      });
      await poll();
    } catch (e) { alert('錯誤：' + e.message); okBtn.disabled = false; okBtn.textContent = '送出'; }
  });
}

// 判斷這次下單是否會覆蓋既有紀錄（依 backend user_id 規則）
function findExistingEntry(zone, memberName, nonMemberName) {
  const entries = (state.entries || []);
  const zones = (state.zones || []);
  const zRow = zones.find(z => z.name === zone);
  const unlimited = zRow && +zRow.capacity === 0;
  // 名字比對前去掉 web 紀錄的「🌐 」前綴與空白
  const normName = (s) => String(s || '').replace(/^🌐\\s*/, '').replace(/（非會員）$/, '').trim();
  if (/衛生局/.test(zone)) {
    if (nonMemberName) return null; // 衛生局非會員每次都新建
    if (memberName) {
      const target = normName(memberName);
      return entries.find(e => e.zone === zone && normName(e.name) === target) || null;
    }
    return null;
  }
  if (unlimited) return null; // 其他不限人數區（如檢驗中心）每次都新建
  // 一般區：同區覆蓋
  return entries.find(e => e.zone === zone) || null;
}

function askAddOrReplace(existing, newItem, newPrice) {
  return new Promise(resolve => {
    const oldItem = (existing.data && existing.data['品項']) || '(無品項)';
    const oldPriceStr = existing.price ? ' $' + existing.price : '';
    const newPriceStr = newPrice != null ? ' $' + newPrice : '';
    const who = existing.name || existing.zone || '這筆';
    const d = document.createElement('div');
    d.className = 'order-modal';
    d.innerHTML = '<div class="box">' +
      '<h3>已經點過</h3>' +
      '<div style="padding:4px 0 12px;font-size:13.5px;line-height:1.6">' +
        '<div style="color:var(--text-muted)">' + esc(who) + ' 原訂：</div>' +
        '<div style="color:var(--text);font-weight:600;margin-top:2px">' + esc(oldItem) + esc(oldPriceStr) + '</div>' +
        '<div style="color:var(--text-muted);margin-top:10px">這次要送出：</div>' +
        '<div style="color:var(--gold);font-weight:600;margin-top:2px">' + esc(newItem) + esc(newPriceStr) + '</div>' +
      '</div>' +
      '<div class="row-btns" style="flex-direction:column;gap:8px">' +
        '<button type="button" class="primary" data-a="add">＋ 加點（原訂保留，再加這個）</button>' +
        '<button type="button" data-a="replace">✎ 更改（用新的取代）</button>' +
        '<button type="button" data-a="cancel">取消</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(d);
    const done = (v) => { d.classList.add('closing'); setTimeout(() => d.remove(), 200); resolve(v); };
    d.addEventListener('click', (e) => {
      if (e.target === d) return done(null);
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const a = b.dataset.a;
      done(a === 'add' ? 'add' : a === 'replace' ? 'replace' : null);
    });
  });
}

function openLeaveModal() {
  const zones = (state.zones || []).filter(z => z.enabled !== 0);
  if (!zones.length) { alert('沒有可選的分區'); return; }
  const lastZone = localStorage.getItem(LS_LAST_ZONE) || '';
  const zoneOpts = zones.map(z => {
    const so = +z.sort_order;
    const code = (so >= 100 && so < 1000) ? String(so).padStart(4, '0') + ' ' : '';
    const sel = z.name === lastZone ? ' selected' : '';
    return '<option value="' + esc(z.name) + '"' + sel + '>' + esc(code + z.name) + '</option>';
  }).join('');
  const memberRow = '<div id="omMemberRow" style="display:none">' +
    '<label>是誰請假？（名單內請直接點；不在名單請選「非會員」並填名字）</label>' +
    '<div class="opt-grid" id="omRosterGrid"><span style="color:var(--text-dim);font-size:12px">載入花名冊中…</span></div>' +
    '<div id="omNonMemberInput" style="display:none;margin-top:8px"><input id="omNonMemberName" maxlength="20" placeholder="請輸入非會員姓名"></div>' +
    '</div>' +
    '<div id="omZoneMemberHint" style="display:none;margin-top:6px;font-size:12px;color:var(--jade)"></div>';
  const d = document.createElement('div');
  d.className = 'order-modal';
  d.innerHTML = '<div class="box">' +
    '<h3>登記請假：<span style="color:var(--danger)">📝 請假</span></h3>' +
    '<label>哪一區 / 誰</label><select id="omZone">' + zoneOpts + '</select>' +
    memberRow +
    '<label>備註（選填，例：身體不適）</label><input id="omNote" maxlength="60" placeholder="原因（可留空）">' +
    '<div class="row-btns"><button type="button" id="omCancel">取消</button><button type="button" class="primary" id="omOk">確認請假</button></div>' +
    '</div>';
  document.body.appendChild(d);
  const close = () => { d.classList.add('closing'); setTimeout(() => d.remove(), 200); };
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  const memberRowEl = d.querySelector('#omMemberRow');
  const hintEl = d.querySelector('#omZoneMemberHint');
  const zoneSel = d.querySelector('#omZone');
  const rosterGrid = d.querySelector('#omRosterGrid');
  let rosterAll = null;
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
    rosterGrid.innerHTML = btns + '<button type="button" data-val="__non__" style="background:rgba(240,160,88,.15);color:var(--wine);border-color:rgba(240,160,88,.4)">＋ 非會員</button>';
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
    } catch { rosterGrid.innerHTML = '<span style="color:var(--danger)">花名冊載入失敗</span>'; return; }
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
  d.querySelector('#omCancel').addEventListener('click', close);
  d.querySelector('#omOk').addEventListener('click', async () => {
    const okBtn = d.querySelector('#omOk');
    okBtn.disabled = true; okBtn.textContent = '送出中…';
    const zone = d.querySelector('#omZone').value;
    const note = d.querySelector('#omNote').value.trim() || null;
    let memberName = null, nonMemberName = null;
    if (/衛生局/.test(zone)) {
      const active = rosterGrid.querySelector('button.active');
      if (!active) { alert('請先選「是誰」'); okBtn.disabled = false; okBtn.textContent = '確認請假'; return; }
      if (active.dataset.val === '__non__') {
        nonMemberName = (d.querySelector('#omNonMemberName')?.value || '').trim();
        if (!nonMemberName) { alert('請填非會員姓名'); okBtn.disabled = false; okBtn.textContent = '確認請假'; return; }
      } else {
        memberName = active.dataset.val;
      }
    }
    try {
      const r = await fetch('/api/t/' + TASK_ID + '/quick-entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone, leave: true, note, memberName, nonMemberName }),
      });
      const j = await r.json();
      if (!r.ok) { alert('失敗：' + (j.error || r.status)); okBtn.disabled = false; okBtn.textContent = '確認請假'; return; }
      localStorage.setItem(LS_LAST_ZONE, zone);
      close();
      showToast('✓ 已登記請假');
      await poll();
    } catch (e) { alert('錯誤：' + e.message); okBtn.disabled = false; okBtn.textContent = '確認請假'; }
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
