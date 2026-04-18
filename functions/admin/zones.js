// 分區設定管理頁（全域）— 需帶 ?uid=<LINE userId>，且必須是 ADMIN_USER_IDS 名單
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const uid = String(url.searchParams.get('uid') || '').trim();
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!uid || !adminIds.includes(uid)) {
    return new Response(
      `<!DOCTYPE html><meta charset="utf-8"><title>需要管理員連結</title><style>body{font-family:-apple-system,"PingFang TC",sans-serif;max-width:440px;margin:80px auto;padding:20px;text-align:center;color:#666;line-height:1.6}</style><h2>🔒 請從 LINE 進入</h2><p>請在 LINE 群組對小秘書說「<b>分區設定</b>」索取連結。</p>`,
      { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>分區設定</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif; max-width: 720px; margin: 0 auto; padding: 16px; line-height: 1.5; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd4; }
.hint { color: #888; font-size: 13px; margin-bottom: 10px; }
button { padding: 7px 14px; font-size: 13px; cursor: pointer; border-radius: 6px; border: 1px solid #ccc4; background: #f0f0f022; }
button.primary { background: #2db87a; color: white; border-color: #2db87a; font-weight: 600; }
button.primary:hover { background: #249864; }
.add { margin: 12px 0; display: flex; gap: 8px; }
.add input { flex: 1; padding: 6px 8px; font-size: 14px; border: 1px solid #ccc4; border-radius: 4px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; }
.msg { color: #2db87a; font-size: 13px; }
.msg.error { color: #d4543a; }
.zone-grid { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px; border: 1px solid #ddd4; border-radius: 6px; }
.zone-chip { display: inline-block; padding: 4px 10px; font-size: 13px; border-radius: 14px; cursor: pointer; user-select: none; white-space: nowrap; border: 1px solid transparent; transition: all .12s; }
.zone-chip.on { background: #2e7fe6; color: #fff; border-color: #2e7fe6; }
.zone-chip.off { background: #e8e8e8; color: #888; border-color: #ccc6; }
@media (prefers-color-scheme: dark) {
  .zone-chip.off { background: #3a3a3a; color: #888; border-color: #555; }
}
.zone-chip:hover { opacity: .85; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #eee4; }
.uid { font-family: monospace; font-size: 10px; color: #888; word-break: break-all; max-width: 180px; }
.zone-pick { padding: 3px 5px; font-size: 12px; }
details { margin: 10px 0; }
summary { cursor: pointer; padding: 6px 0; font-weight: 600; font-size: 14px; }
</style>
</head>
<body>
<h1>分區設定</h1>
<div class="hint">全域共用。勾選 = 啟用；衛生局不限人數，其他限 1 人。</div>

<h2>① 區清單</h2>
<div id="zones" class="zone-grid"></div>
<div class="add">
  <input id="newZone" placeholder="新增自訂區名（例：市政府、消防局）">
  <button onclick="addZone()">➕ 新增</button>
</div>
<div class="toolbar">
  <span class="msg" id="zoneMsg"></span>
  <button class="primary" onclick="saveZones()">💾 儲存</button>
</div>

<h2>② 成員區對照</h2>
<details open>
<summary id="memSummary">載入中…</summary>
<table id="members">
  <thead><tr><th>姓名</th><th>LINE ID</th><th>區</th><th>上次出現</th></tr></thead>
  <tbody></tbody>
</table>
</details>

<script>
const UID = ${JSON.stringify(uid)};
const Q = '?uid=' + encodeURIComponent(UID);
let ZONES = [];
let MEMBERS = [];

async function load() {
  const [z, m] = await Promise.all([
    fetch('/api/zones' + Q).then(r => r.json()),
    fetch('/api/members' + Q).then(r => r.json()),
  ]);
  ZONES = z.zones || [];
  MEMBERS = m.members || [];
  renderZones();
  renderMembers();
}

function zoneLabel(z) {
  const n = +z.sort_order;
  if (n >= 100 && n < 1000) return String(n).padStart(4, '0') + ' ' + z.name;
  return z.name;
}

function renderZones() {
  const box = document.getElementById('zones');
  box.innerHTML = ZONES.map((z, i) => \`
    <span class="zone-chip \${z.enabled ? 'on' : 'off'}" data-i="\${i}">\${esc(zoneLabel(z))}</span>\`).join('');
  box.querySelectorAll('.zone-chip').forEach(el => {
    el.addEventListener('click', () => {
      const i = +el.dataset.i;
      ZONES[i].enabled = ZONES[i].enabled ? 0 : 1;
      el.classList.toggle('on', !!ZONES[i].enabled);
      el.classList.toggle('off', !ZONES[i].enabled);
    });
  });
}

function addZone() {
  const name = document.getElementById('newZone').value.trim();
  if (!name) return;
  if (ZONES.some(z => z.name === name)) { msg('已存在', true); return; }
  const maxSort = Math.max(0, ...ZONES.map(z => +z.sort_order || 0));
  ZONES.push({ name, capacity: 1, enabled: 1, sort_order: maxSort + 1 });
  document.getElementById('newZone').value = '';
  renderZones();
}

async function saveZones() {
  // 保留既有 sort_order（不要被 index 覆寫）
  const r = await fetch('/api/zones' + Q, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zones: ZONES }),
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
    const optHtml = ['<option value="">（未分區）</option>', ...zonesOn.map(z => \`<option value="\${esc(z.name)}">\${esc(zoneLabel(z))}</option>\`)].join('');
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
  const r = await fetch('/api/zone/tag' + Q, {
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
