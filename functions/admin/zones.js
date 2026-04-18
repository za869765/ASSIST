// 分區設定管理頁（全域）
export async function onRequestGet() {
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>分區設定</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif; max-width: 860px; margin: 0 auto; padding: 16px; line-height: 1.5; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd4; }
.hint { color: #888; font-size: 13px; margin-bottom: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee4; }
th { background: #f0f0f022; font-weight: 600; }
td.name { font-weight: 500; }
td.cap input { width: 60px; padding: 4px 6px; }
td.center, th.center { text-align: center; }
button { padding: 8px 16px; font-size: 14px; cursor: pointer; border-radius: 6px; border: 1px solid #ccc4; background: #f0f0f022; }
button.primary { background: #2db87a; color: white; border-color: #2db87a; font-weight: 600; }
button.primary:hover { background: #249864; }
.add { margin: 12px 0; display: flex; gap: 8px; }
.add input { flex: 1; padding: 6px 8px; font-size: 14px; border: 1px solid #ccc4; border-radius: 4px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; }
.msg { color: #2db87a; font-size: 13px; }
.msg.error { color: #d4543a; }
.uid { font-family: monospace; font-size: 11px; color: #888; word-break: break-all; max-width: 220px; }
.zone-pick { padding: 4px 6px; font-size: 13px; }
details { margin: 12px 0; }
summary { cursor: pointer; padding: 8px 0; font-weight: 600; }
small.capnote { color: #888; margin-left: 4px; }
</style>
</head>
<body>
<h1>分區設定</h1>
<div class="hint">這份設定為全域共用，所有群組 / 任務都會參照。每區限 1 人，檢驗中心不限。</div>

<h2>① 區清單</h2>
<table id="zones">
  <thead><tr><th style="width:30px"></th><th>名稱</th><th class="center" style="width:100px">啟用</th></tr></thead>
  <tbody></tbody>
</table>
<div class="add">
  <input id="newZone" placeholder="新增自訂區名（例：市政府、消防局）">
  <button onclick="addZone()">➕ 新增</button>
</div>
<div class="toolbar">
  <span class="msg" id="zoneMsg"></span>
  <button class="primary" onclick="saveZones()">💾 儲存區清單</button>
</div>

<h2>② 成員區對照</h2>
<div class="hint">已註冊的 LINE 成員。可以手動改他們的區（或清空）。</div>
<details open>
<summary id="memSummary">載入中…</summary>
<table id="members">
  <thead><tr><th>姓名</th><th>LINE ID</th><th>區</th><th>上次出現</th></tr></thead>
  <tbody></tbody>
</table>
</details>

<script>
let ZONES = [];
let MEMBERS = [];

async function load() {
  const [z, m] = await Promise.all([
    fetch('/api/zones').then(r => r.json()),
    fetch('/api/members').then(r => r.json()),
  ]);
  ZONES = z.zones || [];
  MEMBERS = m.members || [];
  renderZones();
  renderMembers();
}

function renderZones() {
  const tbody = document.querySelector('#zones tbody');
  tbody.innerHTML = ZONES.map((z, i) => \`
    <tr data-i="\${i}">
      <td class="center">\${i + 1}</td>
      <td class="name">\${esc(z.name)}</td>
      <td class="center"><input type="checkbox" \${z.enabled ? 'checked' : ''} onchange="ZONES[\${i}].enabled = this.checked ? 1 : 0"></td>
    </tr>\`).join('');
}

function addZone() {
  const name = document.getElementById('newZone').value.trim();
  const cap = parseInt(document.getElementById('newCap').value) || 0;
  if (!name) return;
  if (ZONES.some(z => z.name === name)) {
    msg('已存在', true);
    return;
  }
  ZONES.push({ name, capacity: cap, enabled: 1, sort_order: (ZONES.length + 1) * 10 });
  document.getElementById('newZone').value = '';
  document.getElementById('newCap').value = '1';
  renderZones();
}

async function saveZones() {
  const r = await fetch('/api/zones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zones: ZONES.map((z, i) => ({ ...z, sort_order: (i + 1) * 10 })) }),
  });
  if (r.ok) { msg('已儲存 ✓'); load(); }
  else msg('儲存失敗', true);
}

function msg(t, err) {
  const el = document.getElementById('zoneMsg');
  el.textContent = t;
  el.className = 'msg' + (err ? ' error' : '');
  setTimeout(() => { el.textContent = ''; }, 3000);
}

function renderMembers() {
  const tbody = document.querySelector('#members tbody');
  const zonesOn = ZONES.filter(z => z.enabled);
  const unassigned = MEMBERS.filter(m => !m.zone).length;
  document.getElementById('memSummary').textContent = \`共 \${MEMBERS.length} 人（未分區：\${unassigned}）\`;
  tbody.innerHTML = '';
  for (const m of MEMBERS) {
    const name = m.real_name || m.line_display || '(未命名)';
    const dt = (m.last_seen_at || '').slice(0, 16);
    const isSynth = String(m.user_id || '').startsWith('zone:');
    const tr = document.createElement('tr');
    const optHtml = ['<option value="">（未分區）</option>', ...zonesOn.map(z => \`<option value="\${esc(z.name)}">\${esc(z.name)}</option>\`)].join('');
    tr.innerHTML = \`
      <td>\${esc(name)}\${isSynth ? ' <small style="color:#888">[代點]</small>' : ''}</td>
      <td class="uid">\${esc(m.user_id)}</td>
      <td><select class="zone-pick">\${optHtml}</select></td>
      <td><small>\${esc(dt)}</small></td>\`;
    const sel = tr.querySelector('select');
    sel.value = m.zone || '';
    sel.addEventListener('change', () => tagMember(m.user_id, sel.value));
    tbody.appendChild(tr);
  }
}

async function tagMember(user_id, zone) {
  const r = await fetch('/api/zone/tag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id, zone }),
  });
  if (r.ok) {
    const hit = MEMBERS.find(m => m.user_id === user_id);
    if (hit) hit.zone = zone || null;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

load();
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
