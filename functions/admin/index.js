// 後台 hub：/admin URL 直接進入，密碼登入後分頁顯示
// 不靠 referrer，沒任務時也能維護
export async function onRequestGet() {
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ASSIST 管理後台</title>
<meta name="version" content="v1.0.35">
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif; max-width: 880px; margin: 0 auto; padding: 16px; line-height: 1.5; }
h1 { font-size: 22px; margin: 0 0 6px; display: flex; justify-content: space-between; align-items: center; }
.sub { color: #888; font-size: 12px; margin-bottom: 16px; }
.tabs { display: flex; gap: 4px; border-bottom: 2px solid #ddd4; margin-bottom: 16px; flex-wrap: wrap; }
.tab { padding: 8px 14px; cursor: pointer; border: none; background: transparent; font-size: 14px; color: inherit; border-bottom: 3px solid transparent; margin-bottom: -2px; font-weight: 500; }
.tab.active { border-bottom-color: #2db87a; color: #2db87a; font-weight: 700; }
.panel { display: none; }
.panel.active { display: block; }
h2 { font-size: 16px; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd4; }
button { padding: 7px 14px; font-size: 13px; cursor: pointer; border-radius: 6px; border: 1px solid #ccc4; background: #f0f0f022; color: inherit; }
button:hover { background: #ddd4; }
button.primary { background: #2db87a; color: white; border-color: #2db87a; font-weight: 600; }
button.primary:hover { background: #249864; }
button.danger { background: #d4543a; color: white; border-color: #d4543a; }
button.danger:hover { background: #b14328; }
input[type="text"], input[type="password"] { padding: 7px 10px; font-size: 14px; border: 1px solid #ccc4; border-radius: 4px; background: transparent; color: inherit; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee4; vertical-align: top; }
th { background: #f5f5f522; }
.uid { font-family: monospace; font-size: 11px; color: #888; word-break: break-all; max-width: 240px; }
.msg { color: #2db87a; font-size: 13px; padding: 4px 0; }
.msg.error { color: #d4543a; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-right: 4px; }
.b-ok { background: #e8f5e9; color: #1b5e20; }
.b-warn { background: #fff3e0; color: #e65100; }
.b-err { background: #ffebee; color: #b71c1c; }
.b-info { background: #e3f2fd; color: #1565c0; }
.b-mute { background: #eceff1; color: #607d8b; }
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; font-size: 13px; padding: 8px 0; }
.kv b { color: #607d8b; font-weight: 500; }
.add-row { display: flex; gap: 8px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
.add-row input { flex: 1; min-width: 200px; }
.login-box { max-width: 360px; margin: 60px auto; padding: 24px; border: 1px solid #ddd4; border-radius: 8px; text-align: center; }
.login-box input { width: 100%; margin: 12px 0; }
.login-box button { width: 100%; }
.foot { color: #90a4ae; font-size: 11px; margin-top: 32px; text-align: center; }
.zone-link { font-size: 13px; color: #1565c0; text-decoration: none; }
.zone-link:hover { text-decoration: underline; }
small.note { color: #888; font-size: 11px; }
.tasks-row td { font-size: 12px; }
.dl-link { display: inline-block; padding: 2px 8px; font-size: 11px; background: #e3f2fd; color: #1565c0; border-radius: 4px; text-decoration: none; margin: 1px 2px; }
.dl-link.expired { background: #eceff1; color: #999; }
.detail-btn { display: inline-block; padding: 2px 8px; font-size: 11px; background: #fff3e0; color: #e65100; border: none; border-radius: 4px; cursor: pointer; margin: 1px 2px; font-family: inherit; }
.detail-btn:hover { background: #ffe0b2; }
.modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 100; align-items: flex-start; justify-content: center; padding: 32px 16px; overflow-y: auto; }
.modal-overlay.show { display: flex; }
.modal-box { background: var(--bg, #fff); color: inherit; max-width: 760px; width: 100%; border-radius: 10px; padding: 18px 22px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); position: relative; max-height: calc(100vh - 64px); overflow-y: auto; }
@media (prefers-color-scheme: dark) { .modal-box { background: #1e1e1e; } }
.modal-close { position: absolute; top: 10px; right: 12px; background: transparent; border: none; font-size: 22px; cursor: pointer; color: #888; padding: 4px 10px; }
.modal-close:hover { color: #333; }
.modal-title { font-size: 17px; margin: 0 0 4px; padding-right: 32px; font-weight: 700; }
.modal-meta { font-size: 12px; color: #888; margin-bottom: 12px; }
.modal-summary { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 13px; padding: 10px 12px; background: #f7f7f733; border-radius: 6px; margin-bottom: 12px; }
.modal-summary b { color: #607d8b; font-weight: 500; margin-right: 4px; }
.zone-block { margin-bottom: 14px; }
.zone-head { font-size: 13px; font-weight: 700; color: #2db87a; padding: 4px 0; border-bottom: 1px solid #ddd4; margin-bottom: 4px; }
.entry-row { font-size: 13px; padding: 6px 0; border-bottom: 1px solid #eee2; }
.entry-row b { color: inherit; font-weight: 600; }
.entry-data { color: #555; font-size: 12px; margin-left: 4px; }
.entry-note { color: #d4543a; font-size: 11px; margin-left: 4px; }
.entry-price { color: #2db87a; font-size: 12px; font-weight: 600; float: right; }
.entry-uid { font-family: monospace; font-size: 10px; color: #999; margin-top: 2px; word-break: break-all; }
.group-members-row td { background: #f8f8f822; padding: 8px 14px; border-bottom: 2px solid #ddd4; }
.group-members-row table { width: 100%; font-size: 12px; }
.group-members-row th { font-size: 11px; color: #888; font-weight: 500; }
.group-members-row td { padding: 4px 6px; }
.expand-btn { padding: 3px 10px; font-size: 11px; background: #e3f2fd; color: #1565c0; border: 1px solid #bbdefb; border-radius: 4px; cursor: pointer; font-family: inherit; }
.expand-btn:hover { background: #bbdefb; }
</style>
</head>
<body>

<div id="loginPanel" class="login-box" style="display:none">
  <h2 style="border:none">🔒 後台登入</h2>
  <div class="sub" id="loginHint">請輸入管理密碼</div>
  <input id="passInput" type="password" placeholder="密碼" autocomplete="current-password">
  <button class="primary" onclick="doLogin()">登入</button>
  <div class="msg error" id="loginMsg"></div>
</div>

<div id="mainPanel" style="display:none">
  <h1>🛠 ASSIST 管理後台
    <button onclick="doLogout()" style="font-size:12px">登出</button>
  </h1>
  <div class="sub">v1.0.35 · LINE Bot 統一維護</div>

  <div class="tabs">
    <button class="tab active" data-tab="overview">總覽</button>
    <button class="tab" data-tab="admins">管理員</button>
    <button class="tab" data-tab="groups">群組</button>
    <button class="tab" data-tab="tasks">歷史任務</button>
    <button class="tab" data-tab="members">全部成員</button>
    <button class="tab" data-tab="more">其他</button>
  </div>

  <div id="overview" class="panel active">
    <h2>🩺 服務狀態</h2>
    <div id="healthBox">載入中…</div>
    <h2>📌 快速連結</h2>
    <ul style="font-size:14px;line-height:2">
      <li><a class="zone-link" href="/admin/zones">分區設定 / 成員區對照</a>（含姓名編輯、刪除成員）</li>
      <li><a class="zone-link" href="/">首頁狀態</a></li>
    </ul>
  </div>

  <div id="admins" class="panel">
    <h2>👤 管理員白名單</h2>
    <small class="note">env.ADMIN_USER_IDS 是 Cloudflare 環境變數（不能在這裡刪），D1 admins 是線上加的（即時生效，30 秒內 webhook 認得）</small>
    <div class="add-row">
      <input id="newAdminId" type="text" placeholder="LINE userId（U 開頭 33 位）">
      <input id="newAdminNote" type="text" placeholder="備註（選填，例：張小姐）" style="flex:0 0 200px">
      <button class="primary" onclick="addAdmin()">新增</button>
    </div>
    <div class="msg" id="adminMsg"></div>
    <table id="adminTable">
      <thead><tr><th>姓名 / 備註</th><th>LINE userId</th><th>來源</th><th>建立時間</th><th>操作</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div id="groups" class="panel">
    <h2>👥 群組設定</h2>
    <small class="note">列出所有 bot 進過的群組，可加備註別名、停用某群組（停用後非管理員訊息一律不回應）</small>
    <div class="msg" id="groupMsg"></div>
    <table id="groupTable">
      <thead><tr><th>群組</th><th>備註別名</th><th>狀態</th><th>任務數</th><th>最後活動</th><th>成員</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div id="tasks" class="panel">
    <h2>📋 歷史任務</h2>
    <div class="add-row">
      <button onclick="loadTasks('all')">全部</button>
      <button onclick="loadTasks('closed')">已結單</button>
      <button onclick="loadTasks('open')">進行中</button>
      <small class="note" id="tasksCount"></small>
    </div>
    <table id="taskTable">
      <thead><tr><th>任務</th><th>群組</th><th>狀態</th><th>筆數</th><th>建立</th><th>結單</th><th>詳情</th><th>下載</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div id="members" class="panel">
    <h2>👥 成員管理</h2>
    <div class="add-row" style="margin:10px 0;gap:10px">
      <label style="font-size:13px;color:#888">模式：</label>
      <select id="memberGroupSelect" onchange="onMemberGroupChange()" style="padding:5px 8px;font-size:13px;flex:1;max-width:300px;border:1px solid #ccc6;border-radius:4px;background:transparent;color:inherit">
        <option value="">— 全部成員（全域 members 表）—</option>
      </select>
      <input id="memberSearch" type="text" placeholder="搜尋（姓名 / userId / 暱稱）" oninput="renderAllMembers()" style="flex:1;min-width:180px">
      <small class="note" id="memberCount"></small>
    </div>
    <div id="memberModeBanner" style="padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:8px"></div>
    <div class="msg" id="memberMsg"></div>
    <table id="memberTable">
      <thead><tr><th>姓名</th><th>LINE 暱稱</th><th>LINE userId</th><th>分區</th><th>最後</th><th>操作</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div id="more" class="panel">
    <h2>⚙ 其他</h2>
    <div class="kv">
      <b>D1 binding</b><div>DB → assist_db</div>
      <b>分區設定</b><div><a class="zone-link" href="/admin/zones">/admin/zones</a></div>
      <b>Webhook URL</b><div><code id="webhookUrl">—</code></div>
      <b>後台版本</b><div>v1.0.35</div>
    </div>
    <h2>💡 LINE 指令備忘</h2>
    <ul style="font-size:13px;line-height:1.8;color:#666">
      <li><code>TAQ 小秘書 我的ID</code> — 取得自己的 LINE userId（用來加白名單）</li>
      <li><code>TAQ 小秘書 ping</code> — 環境摘要（管理員限定）</li>
      <li>群組裡輸入「秘書 開始統計飲料」開新任務</li>
    </ul>
  </div>
</div>

<div class="modal-overlay" id="taskModal" onclick="if(event.target===this)closeTaskModal()">
  <div class="modal-box">
    <button class="modal-close" onclick="closeTaskModal()">×</button>
    <div id="taskModalBody">載入中…</div>
  </div>
</div>

<div class="foot">ASSIST · Cloudflare Pages + D1 · Gemini 2.5 Flash</div>

<script>
const LS_KEY = 'assist_admin_pass';
let PASS = localStorage.getItem(LS_KEY) || '';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), 'X-Admin-Pass': PASS };
  if (opts.body && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  return fetch(path, opts);
}
function showMsg(id, t, err) {
  const el = document.getElementById(id);
  el.textContent = t;
  el.className = 'msg' + (err ? ' error' : '');
  if (t) setTimeout(() => { el.textContent = ''; }, 3500);
}

async function doLogin() {
  const p = document.getElementById('passInput').value.trim();
  if (!p) return;
  const r = await fetch('/api/admin/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: p }),
  });
  if (r.ok) {
    PASS = p;
    localStorage.setItem(LS_KEY, p);
    showApp();
  } else if (r.status === 503) {
    const j = await r.json().catch(() => ({}));
    document.getElementById('loginMsg').textContent = j.reason || 'ADMIN_PASS 未設定，請聯絡部署管理員';
  } else {
    document.getElementById('loginMsg').textContent = '密碼錯誤';
  }
}
function doLogout() {
  PASS = '';
  localStorage.removeItem(LS_KEY);
  document.getElementById('mainPanel').style.display = 'none';
  document.getElementById('loginPanel').style.display = '';
}

async function tryAutoLogin() {
  if (!PASS) return false;
  const r = await fetch('/api/admin/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: PASS }),
  });
  return r.ok;
}

function showApp() {
  document.getElementById('loginPanel').style.display = 'none';
  document.getElementById('mainPanel').style.display = '';
  loadOverview();
  loadAdmins();
  loadGroups();
  loadTasks('all');
  loadAllMembers();
  document.getElementById('webhookUrl').textContent = location.origin + '/api/line/webhook';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('loginPanel').style.display !== 'none') doLogin();
});

// ========== Tab 切換 ==========
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    const id = btn.dataset.tab;
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === id));
  });
});

// ========== 總覽 ==========
async function loadOverview() {
  const box = document.getElementById('healthBox');
  try {
    const j = await fetch('/api/health').then(r => r.json());
    const yn = b => b ? '<span class="badge b-ok">✅</span>' : '<span class="badge b-warn">⚠ 未設</span>';
    box.innerHTML = \`
      <div class="kv">
        <b>D1 連線</b><div>\${j.d1 === 'ok' ? '<span class="badge b-ok">✅ ok</span>' : '<span class="badge b-err">✗ 失敗</span>'}</div>
        <b>LINE Secret</b><div>\${yn(j.line_secret)}</div>
        <b>LINE Token</b><div>\${yn(j.line_token)}</div>
        <b>Gemini Key</b><div>\${yn(j.gemini_key)}</div>
        <b>後台密碼</b><div>\${yn(j.admin_pass)}</div>
        <b>管理員總數</b><div><b>\${j.admin_count}</b> 人（env: \${j.admin_env_count} / D1: \${j.admin_db_count}）</div>
        <b>時間</b><div><small>\${j.time}</small></div>
      </div>\`;
  } catch (e) { box.innerHTML = '<span class="badge b-err">無法取得狀態</span> ' + esc(e.message); }
}

// ========== 管理員 ==========
async function loadAdmins() {
  const r = await api('/api/admin/admins');
  if (!r.ok) { showMsg('adminMsg', '載入失敗', true); return; }
  const j = await r.json();
  const rows = [];
  for (const uid of j.env) {
    const m = j.members[uid] || {};
    const name = m.real_name || m.line_display || '<span style="color:#999">(未綁定)</span>';
    rows.push(\`<tr>
      <td>\${esc(name)}</td>
      <td class="uid">\${esc(uid)}</td>
      <td><span class="badge b-info">env</span></td>
      <td><small>—</small></td>
      <td><small style="color:#999">env 不可刪</small></td>
    </tr>\`);
  }
  for (const a of j.db) {
    const m = j.members[a.user_id] || {};
    const name = m.real_name || m.line_display || a.note || '<span style="color:#999">(未綁定)</span>';
    rows.push(\`<tr>
      <td>\${esc(name)} \${a.note ? '<small class="note">'+esc(a.note)+'</small>' : ''}</td>
      <td class="uid">\${esc(a.user_id)}</td>
      <td><span class="badge b-ok">D1</span></td>
      <td><small>\${esc((a.created_at || '').slice(0, 16))}</small></td>
      <td><button class="danger" onclick="delAdmin('\${esc(a.user_id)}')">刪除</button></td>
    </tr>\`);
  }
  document.querySelector('#adminTable tbody').innerHTML = rows.join('') || '<tr><td colspan="5" style="text-align:center;color:#999">尚無管理員</td></tr>';
}

async function addAdmin() {
  const uid = document.getElementById('newAdminId').value.trim();
  const note = document.getElementById('newAdminNote').value.trim();
  if (!uid) return showMsg('adminMsg', '請輸入 LINE userId', true);
  const r = await api('/api/admin/admins', { method: 'POST', body: JSON.stringify({ user_id: uid, note }) });
  if (r.ok) {
    document.getElementById('newAdminId').value = '';
    document.getElementById('newAdminNote').value = '';
    showMsg('adminMsg', '已新增 ✓');
    loadAdmins();
  } else {
    const t = await r.text();
    showMsg('adminMsg', '新增失敗：' + t, true);
  }
}

async function delAdmin(uid) {
  if (!confirm('確定移除此管理員？\\n' + uid)) return;
  const r = await api('/api/admin/admins', { method: 'DELETE', body: JSON.stringify({ user_id: uid }) });
  if (r.ok) { showMsg('adminMsg', '已刪除 ✓'); loadAdmins(); }
  else showMsg('adminMsg', '刪除失敗', true);
}

// ========== 群組 ==========
async function loadGroups() {
  const r = await api('/api/admin/groups');
  if (!r.ok) { showMsg('groupMsg', '載入失敗', true); return; }
  const j = await r.json();
  const rows = (j.groups || []).map(g => {
    const dt = (g.last_active_at || '').slice(0, 16);
    const enabledBadge = g.enabled ? '<span class="badge b-ok">啟用</span>' : '<span class="badge b-mute">停用</span>';
    return \`<tr>
      <td class="uid">\${esc(g.group_id)}</td>
      <td><input type="text" value="\${esc(g.alias || '')}" placeholder="(無備註)" data-gid="\${esc(g.group_id)}" class="alias-edit" style="width:160px;padding:4px 6px;font-size:13px;border:1px solid #ccc6;border-radius:4px;background:transparent;color:inherit"></td>
      <td>\${enabledBadge} <button onclick="toggleGroup('\${esc(g.group_id)}', \${g.enabled ? 0 : 1})" style="font-size:11px;padding:2px 8px">切換</button></td>
      <td><small>\${g.task_total} 個（進行 \${g.open_count}）</small></td>
      <td><small>\${esc(dt)}</small></td>
      <td><button class="expand-btn" onclick="toggleGroupMembers('\${esc(g.group_id)}', this)">👥 成員</button></td>
    </tr>\`;
  });
  document.querySelector('#groupTable tbody').innerHTML = rows.join('') || '<tr><td colspan="6" style="text-align:center;color:#999">尚無已知群組（bot 至少要被加入一個群並收到訊息）</td></tr>';
  document.querySelectorAll('.alias-edit').forEach(inp => {
    inp.addEventListener('blur', async () => {
      const gid = inp.dataset.gid;
      const alias = inp.value.trim();
      const r = await api('/api/admin/groups', { method: 'PATCH', body: JSON.stringify({ group_id: gid, alias }) });
      if (r.ok) showMsg('groupMsg', '已更新備註 ✓');
      else showMsg('groupMsg', '更新失敗', true);
    });
  });
}

async function toggleGroup(gid, newEnabled) {
  const r = await api('/api/admin/groups', { method: 'PATCH', body: JSON.stringify({ group_id: gid, enabled: !!newEnabled }) });
  if (r.ok) { showMsg('groupMsg', newEnabled ? '已啟用 ✓' : '已停用 ✓'); loadGroups(); }
  else showMsg('groupMsg', '切換失敗', true);
}

// 群組成員 inline 展開（per-group 編輯：寫進 group_members；空值 fallback 到全域 members）
async function toggleGroupMembers(gid, btn) {
  const tr = btn.closest('tr');
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('group-members-row')) {
    next.remove();
    btn.textContent = '👥 成員';
    return;
  }
  btn.textContent = '⏳';
  if (ZONES_CACHE.length === 0) await loadZonesCache();
  const r = await api('/api/admin/group-members?group_id=' + encodeURIComponent(gid));
  if (!r.ok) { btn.textContent = '👥 成員'; showMsg('groupMsg', '載入成員失敗（' + r.status + '）', true); return; }
  const j = await r.json();
  const members = j.members || [];
  const expandTr = document.createElement('tr');
  expandTr.className = 'group-members-row';
  const td = document.createElement('td');
  td.colSpan = 6;
  if (members.length === 0) {
    td.innerHTML = '<small style="color:#999">尚無訂單紀錄</small>';
  } else {
    const inner = members.map(m => {
      const last = (m.last_entry_at || '').slice(0, 16);
      const nameVal = m.group_real_name || '';
      const namePh = m.global_real_name || m.line_display || '(未填)';
      const zoneVal = m.group_zone || '';
      const hasOverride = m.group_real_name || m.group_zone;
      const overrideTag = hasOverride ? '<span class="badge b-info" style="font-size:9px;margin-left:4px">override</span>' : '';
      return \`<tr>
        <td>
          <input type="text" value="\${esc(nameVal)}" placeholder="\${esc(namePh)}" data-gid="\${esc(gid)}" data-uid="\${esc(m.user_id)}" class="gm-name" style="width:120px;padding:3px 6px;font-size:12px;border:1px solid #ccc6;border-radius:4px;background:transparent;color:inherit">
          \${overrideTag}
        </td>
        <td><small>\${esc(m.line_display || '')}</small></td>
        <td class="uid">\${esc(m.user_id)}</td>
        <td>
          <select data-gid="\${esc(gid)}" data-uid="\${esc(m.user_id)}" class="gm-zone" style="padding:3px 6px;font-size:12px;border:1px solid #ccc6;border-radius:4px;background:transparent;color:inherit">\${zoneOptionsHtml(zoneVal)}</select>
          <small style="color:#aaa">\${m.global_zone ? '(全域 ' + esc(m.global_zone) + ')' : ''}</small>
        </td>
        <td><small>\${m.entry_count} 筆 · \${esc(last)}</small></td>
        <td>
          \${hasOverride ? '<button class="danger" style="font-size:10px;padding:2px 6px" onclick="clearGroupMemberOverride(\\'' + esc(gid) + '\\', \\'' + esc(m.user_id) + '\\', this)">清</button>' : ''}
        </td>
      </tr>\`;
    }).join('');
    td.innerHTML = \`<small style="color:#888">共 \${members.length} 位（編輯下面表格 → 自動存進 group_members；空值 fallback 全域）</small>
      <table>
        <thead><tr><th>群組姓名</th><th>LINE 暱稱</th><th>userId</th><th>群組分區</th><th>訂單 / 最後</th><th>override</th></tr></thead>
        <tbody>\${inner}</tbody>
      </table>\`;
  }
  expandTr.appendChild(td);
  tr.parentNode.insertBefore(expandTr, tr.nextSibling);
  btn.textContent = '▲ 收合';

  // Bind inline editors
  expandTr.querySelectorAll('.gm-name').forEach(inp => {
    inp.addEventListener('blur', async () => {
      const v = inp.value.trim();
      const ok = await patchGroupMember(inp.dataset.gid, inp.dataset.uid, { real_name: v });
      if (ok) showMsg('groupMsg', '已更新群組姓名 ' + (v || '(清空 → fallback)'));
    });
  });
  expandTr.querySelectorAll('.gm-zone').forEach(sel => {
    sel.addEventListener('change', async () => {
      const ok = await patchGroupMember(sel.dataset.gid, sel.dataset.uid, { zone: sel.value });
      if (ok) showMsg('groupMsg', '已更新群組分區 → ' + (sel.value || '(清空 → fallback)'));
    });
  });
}

async function patchGroupMember(group_id, user_id, fields) {
  const r = await fetch('/api/admin/group-members', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Pass': PASS },
    body: JSON.stringify({ group_id, user_id, ...fields }),
  });
  if (!r.ok) {
    showMsg('groupMsg', 'per-group 更新失敗（' + r.status + '）', true);
    return false;
  }
  return true;
}

async function clearGroupMemberOverride(gid, uid, btn) {
  if (!confirm('清除此成員在本群的 override（real_name + zone）？\\n清除後該成員此群內顯示會 fallback 全域 members 設定。')) return;
  const r = await fetch('/api/admin/group-members', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Pass': PASS },
    body: JSON.stringify({ group_id: gid, user_id: uid }),
  });
  if (!r.ok) { showMsg('groupMsg', '清除失敗', true); return; }
  showMsg('groupMsg', '已清除 override（再展開可看 fallback 後值）');
  // 收合該展開區，讓使用者再展開看最新值
  const expandTr = btn.closest('tr.group-members-row');
  if (expandTr) {
    const prevTr = expandTr.previousElementSibling;
    expandTr.remove();
    if (prevTr) {
      const eb = prevTr.querySelector('.expand-btn');
      if (eb) eb.textContent = '👥 成員';
    }
  }
}

// ========== 歷史任務 ==========
async function loadTasks(status) {
  const r = await api('/api/admin/tasks?limit=80&status=' + status);
  if (!r.ok) return;
  const j = await r.json();
  const tasks = j.tasks || [];
  document.getElementById('tasksCount').textContent = \`共 \${tasks.length} 筆\`;
  const rows = tasks.map(t => {
    const isOpen = t.status === 'open';
    const stBadge = isOpen ? '<span class="badge b-info">進行中</span>' : '<span class="badge b-mute">已結</span>';
    const groupLabel = t.group_alias ? esc(t.group_alias) : '<span class="uid" style="display:inline">' + esc((t.group_id || '').slice(0, 12)) + '…</span>';
    const exps = (t.exports || []).map(ex => {
      const exp = ex.expires_at && Date.parse(ex.expires_at.replace(' ', 'T') + 'Z') < Date.now();
      return \`<a class="dl-link \${exp ? 'expired' : ''}" href="/d/\${esc(ex.token)}" target="_blank" title="\${esc(ex.filename)}（\${ex.download_count || 0} 次下載）">\${exp ? '已到期' : '下載'}</a>\`;
    }).join('') || '<small style="color:#999">—</small>';
    return \`<tr class="tasks-row">
      <td>\${esc(t.task_name)} <small class="note">#\${t.id}</small></td>
      <td>\${groupLabel}</td>
      <td>\${stBadge} \${t.mode === 'menu' ? '<span class="badge b-info" style="font-size:10px">菜單</span>' : ''}</td>
      <td>\${t.entry_count || 0}</td>
      <td><small>\${esc((t.started_at || '').slice(0, 16))}</small></td>
      <td><small>\${esc((t.closed_at || '').slice(0, 16))}</small></td>
      <td><button class="detail-btn" onclick="openTaskDetail(\${t.id})">📋 查看</button></td>
      <td>\${exps}</td>
    </tr>\`;
  });
  document.querySelector('#taskTable tbody').innerHTML = rows.join('') || '<tr><td colspan="8" style="text-align:center;color:#999">尚無任務</td></tr>';
}

// ========== 任務詳情 modal（純查看，不改 task.status，不碰 LINE） ==========
async function openTaskDetail(id) {
  const modal = document.getElementById('taskModal');
  const body = document.getElementById('taskModalBody');
  body.innerHTML = '<div style="padding:24px;text-align:center;color:#888">載入中…</div>';
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';

  const r = await api('/api/admin/tasks/' + id);
  if (!r.ok) {
    body.innerHTML = '<div class="msg error" style="padding:20px">載入失敗（HTTP ' + r.status + '）</div>';
    return;
  }
  const j = await r.json();
  const t = j.task;
  const entries = j.entries || [];
  const sum = j.summary || {};

  const byZone = {};
  for (const e of entries) {
    const z = e.zone || '(未分區)';
    (byZone[z] = byZone[z] || []).push(e);
  }
  const zoneKeys = Object.keys(byZone).sort();

  const stBadge = t.status === 'open'
    ? '<span class="badge b-info">進行中</span>'
    : '<span class="badge b-mute">已結單</span>';
  const modeBadge = t.mode === 'menu'
    ? '<span class="badge b-info" style="font-size:11px">菜單</span>'
    : '<span class="badge b-mute" style="font-size:11px">自由</span>';
  const groupLabel = t.group_alias || (t.group_id || '').slice(0, 16) + '…';

  let html = '';
  html += \`<h3 class="modal-title">\${esc(t.task_name)} <small style="color:#999;font-weight:400">#\${t.id}</small></h3>\`;
  html += \`<div class="modal-meta">\${stBadge} \${modeBadge} · 群組：\${esc(groupLabel)}<br>建立：\${esc((t.started_at || '').slice(0, 16))}\${t.closed_at ? ' · 結單：' + esc(t.closed_at.slice(0, 16)) : ''}</div>\`;

  html += '<div class="modal-summary">';
  html += \`<div><b>總筆數</b>\${sum.entry_count || 0}</div>\`;
  if (sum.total_price) html += \`<div><b>總金額</b>$\${sum.total_price}</div>\`;
  for (const [z, n] of Object.entries(sum.zone_counts || {})) {
    html += \`<div><b>\${esc(z)}</b>\${n}</div>\`;
  }
  html += '</div>';

  if (entries.length === 0) {
    html += '<div style="text-align:center;color:#999;padding:20px">尚無任何訂單</div>';
  } else {
    for (const z of zoneKeys) {
      html += \`<div class="zone-block"><div class="zone-head">\${esc(z)}（\${byZone[z].length}）</div>\`;
      for (const e of byZone[z]) {
        const dataStr = Object.entries(e.data || {})
          .filter(([, v]) => v !== '' && v !== null && v !== undefined)
          .map(([k, v]) => \`\${esc(k)}：\${esc(v)}\`).join(' / ');
        html += '<div class="entry-row">';
        if (e.price) html += \`<span class="entry-price">$\${e.price}</span>\`;
        html += \`<b>\${esc(e.name)}</b>\`;
        if (dataStr) html += \`<span class="entry-data">\${dataStr}</span>\`;
        if (e.note) html += \`<span class="entry-note">📝 \${esc(e.note)}</span>\`;
        if (e.user_id) html += \`<div class="entry-uid">\${esc(e.user_id)}</div>\`;
        html += '</div>';
      }
      html += '</div>';
    }
  }

  body.innerHTML = html;
}

function closeTaskModal() {
  document.getElementById('taskModal').classList.remove('show');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('taskModal').classList.contains('show')) {
    closeTaskModal();
  }
});

// ========== 成員管理（全域 / per-group 雙模式）==========
let ALL_MEMBERS = [];
let ZONES_CACHE = [];
let CURRENT_GROUP_ID = ''; // '' = 全域模式；非空 = 該 group_id 的 per-group 編輯

async function loadZonesCache() {
  try {
    const r = await fetch('/api/zones');
    if (!r.ok) return;
    const j = await r.json();
    ZONES_CACHE = (j.zones || []).filter(z => z.enabled).map(z => z.name);
  } catch {}
}

async function loadGroupOptionsForMembers() {
  const r = await api('/api/admin/groups');
  if (!r.ok) return;
  const j = await r.json();
  const groups = j.groups || [];
  const sel = document.getElementById('memberGroupSelect');
  const opts = ['<option value="">— 全部成員（全域 members 表）—</option>'];
  for (const g of groups) {
    const sid = (g.group_id || '').slice(0, 8) + '…';
    const label = g.alias ? g.alias + '（' + sid + '）' : sid;
    opts.push(\`<option value="\${esc(g.group_id)}">\${esc(label)}</option>\`);
  }
  sel.innerHTML = opts.join('');
}

function onMemberGroupChange() {
  CURRENT_GROUP_ID = document.getElementById('memberGroupSelect').value || '';
  loadMembersPane();
}

function updateMemberModeBanner() {
  const b = document.getElementById('memberModeBanner');
  if (!CURRENT_GROUP_ID) {
    b.innerHTML = '<span class="badge b-warn">⚠ 全域編輯</span> 修改 real_name / zone 會影響「所有群組」的 fallback。要做某群獨立設定請切換上方下拉。';
    b.style.background = '#fff3e022';
    b.style.border = '1px solid #ffe0b2';
  } else {
    const sel = document.getElementById('memberGroupSelect');
    const label = sel.options[sel.selectedIndex]?.text || '此群組';
    b.innerHTML = '<span class="badge b-ok">✓ 群組編輯</span> 在「' + esc(label) + '」內的設定，只影響此群。空值 → fallback 全域 members。';
    b.style.background = '#e8f5e922';
    b.style.border = '1px solid #c8e6c9';
  }
}

function zoneOptionsHtml(currentZone) {
  const cur = currentZone || '';
  let html = \`<option value=""\${cur === '' ? ' selected' : ''}>(未分區)</option>\`;
  // 若目前 zone 不在啟用清單（已軟刪），仍要顯示讓使用者看到
  const list = cur && !ZONES_CACHE.includes(cur) ? [cur, ...ZONES_CACHE] : ZONES_CACHE;
  for (const z of list) html += \`<option value="\${esc(z)}"\${z === cur ? ' selected' : ''}>\${esc(z)}</option>\`;
  return html;
}

async function loadAllMembers() {
  if (ZONES_CACHE.length === 0) await loadZonesCache();
  await loadGroupOptionsForMembers();
  await loadMembersPane();
}

async function loadMembersPane() {
  updateMemberModeBanner();
  if (CURRENT_GROUP_ID) {
    const r = await api('/api/admin/group-members?group_id=' + encodeURIComponent(CURRENT_GROUP_ID));
    if (!r.ok) { showMsg('memberMsg', '載入失敗', true); return; }
    const j = await r.json();
    ALL_MEMBERS = (j.members || []).map(m => ({
      user_id: m.user_id,
      name_val: m.group_real_name || '',
      name_ph:  m.global_real_name || m.line_display || '(未填)',
      line_display: m.line_display || '',
      zone_val: m.group_zone || '',
      zone_fallback: m.global_zone ? '(全域 ' + m.global_zone + ')' : '',
      has_override: !!(m.group_real_name || m.group_zone),
      last_at: m.last_entry_at || '',
      _searchable: [m.group_real_name, m.global_real_name, m.line_display, m.user_id].filter(Boolean).join(' ').toLowerCase(),
    }));
  } else {
    const r = await api('/api/members');
    if (!r.ok) { showMsg('memberMsg', '載入失敗', true); return; }
    const j = await r.json();
    ALL_MEMBERS = (j.members || []).map(m => ({
      user_id: m.user_id,
      name_val: m.real_name || '',
      name_ph:  m.line_display || '(未填)',
      line_display: m.line_display || '',
      zone_val: m.zone || '',
      zone_fallback: '',
      has_override: false,
      last_at: m.last_seen_at || '',
      _searchable: [m.real_name, m.line_display, m.user_id].filter(Boolean).join(' ').toLowerCase(),
    }));
  }
  renderAllMembers();
}

function renderAllMembers() {
  const q = (document.getElementById('memberSearch').value || '').trim().toLowerCase();
  const filtered = q ? ALL_MEMBERS.filter(m => m._searchable.includes(q)) : ALL_MEMBERS;
  document.getElementById('memberCount').textContent = \`共 \${filtered.length} / \${ALL_MEMBERS.length} 位\`;
  const isPerGroup = !!CURRENT_GROUP_ID;
  const rows = filtered.map(m => {
    const last = (m.last_at || '').slice(0, 16);
    const overrideTag = m.has_override ? '<span class="badge b-info" style="font-size:9px;margin-left:4px">override</span>' : '';
    const actionBtn = isPerGroup
      ? \`<button class="danger" style="font-size:11px;padding:3px 8px" onclick="clearMemberOverride('\${esc(m.user_id)}')">✖ 清</button>\`
      : \`<button class="danger" style="font-size:11px;padding:3px 8px" onclick="delMember('\${esc(m.user_id)}', '\${(m.name_val || m.line_display || '').replace(/'/g, '&#39;')}')">🗑 刪除</button>\`;
    return \`<tr>
      <td>
        <input type="text" value="\${esc(m.name_val)}" placeholder="\${esc(m.name_ph)}" data-uid="\${esc(m.user_id)}" class="member-real-name" style="width:140px;padding:4px 6px;font-size:13px;border:1px solid #ccc6;border-radius:4px;background:transparent;color:inherit">
        \${overrideTag}
      </td>
      <td><small>\${esc(m.line_display)}</small></td>
      <td class="uid">\${esc(m.user_id)}</td>
      <td>
        <select data-uid="\${esc(m.user_id)}" class="member-zone" style="padding:4px 6px;font-size:13px;border:1px solid #ccc6;border-radius:4px;background:transparent;color:inherit">\${zoneOptionsHtml(m.zone_val)}</select>
        \${m.zone_fallback ? '<small style="color:#aaa;margin-left:4px">' + esc(m.zone_fallback) + '</small>' : ''}
      </td>
      <td><small>\${esc(last)}</small></td>
      <td>\${actionBtn}</td>
    </tr>\`;
  });
  document.querySelector('#memberTable tbody').innerHTML = rows.join('') || '<tr><td colspan="6" style="text-align:center;color:#999">查無結果</td></tr>';

  document.querySelectorAll('.member-real-name').forEach(inp => {
    inp.addEventListener('blur', async () => {
      const uid = inp.dataset.uid;
      const v = inp.value.trim();
      const ok = await patchMember(uid, { real_name: v });
      if (ok) {
        showMsg('memberMsg', '已更新姓名 ' + (v || '(清空)'));
        const found = ALL_MEMBERS.find(m => m.user_id === uid);
        if (found) {
          found.name_val = v;
          found.has_override = isPerGroup ? !!(v || found.zone_val) : false;
        }
      }
    });
  });

  document.querySelectorAll('.member-zone').forEach(sel => {
    sel.addEventListener('change', async () => {
      const uid = sel.dataset.uid;
      const v = sel.value;
      const ok = await patchMember(uid, { zone: v });
      if (ok) {
        showMsg('memberMsg', '已更新分區 → ' + (v || '(清空)'));
        const found = ALL_MEMBERS.find(m => m.user_id === uid);
        if (found) {
          found.zone_val = v;
          found.has_override = isPerGroup ? !!(found.name_val || v) : false;
        }
      }
    });
  });
}

async function patchMember(uid, fields) {
  const body = CURRENT_GROUP_ID
    ? { group_id: CURRENT_GROUP_ID, user_id: uid, ...fields }
    : { user_id: uid, ...fields };
  const url = CURRENT_GROUP_ID ? '/api/admin/group-members' : '/api/members';
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Pass': PASS },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    showMsg('memberMsg', '更新失敗（' + r.status + '）', true);
    return false;
  }
  return true;
}

async function clearMemberOverride(uid) {
  if (!confirm('清除此成員在本群的 override（姓名 + 分區）？\\n清除後該成員此群內顯示會 fallback 全域 members。')) return;
  const r = await fetch('/api/admin/group-members', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Pass': PASS },
    body: JSON.stringify({ group_id: CURRENT_GROUP_ID, user_id: uid }),
  });
  if (r.ok) {
    showMsg('memberMsg', '已清除 override');
    loadMembersPane();
  } else {
    showMsg('memberMsg', '清除失敗', true);
  }
}

async function delMember(uid, name) {
  if (!confirm('確定刪除成員「' + (name || uid) + '」？\\n\\n會同時清除該成員在進行中任務的訂單（已結單任務不動）。')) return;
  const r = await fetch('/api/members', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: uid }),
  });
  if (r.ok) {
    const j = await r.json().catch(() => ({}));
    showMsg('memberMsg', '已刪除（清 ' + (j.removed_entries || 0) + ' 筆進行中訂單）');
    ALL_MEMBERS = ALL_MEMBERS.filter(m => m.user_id !== uid);
    renderAllMembers();
  } else {
    const t = await r.text().catch(() => '');
    showMsg('memberMsg', '刪除失敗：' + t, true);
  }
}

// ========== 啟動 ==========
(async function init() {
  const ok = await tryAutoLogin();
  if (ok) showApp();
  else {
    document.getElementById('loginPanel').style.display = '';
    if (PASS) {
      PASS = '';
      localStorage.removeItem(LS_KEY);
      document.getElementById('loginMsg').textContent = '密碼已失效，請重新登入';
    }
    setTimeout(() => document.getElementById('passInput').focus(), 50);
  }
})();
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
