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
body { font-family: -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif; max-width: 720px; margin: 0 auto; padding: 16px; line-height: 1.5; }
h1 { font-size: 20px; margin: 0 0 4px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.back-btn { font-size: 14px; font-weight: 600; color: #fff; background: #2db87a; text-decoration: none; padding: 8px 14px; border-radius: 8px; }
.back-btn:hover { background: #249864; }
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
.del-mem { padding: 2px 8px; font-size: 13px; line-height: 1.2; color: #fff; background: #d4543a; border: 1px solid #b14328; border-radius: 4px; cursor: pointer; }
.del-mem:hover { background: #b14328; }
.del-mem:disabled { opacity: .5; cursor: wait; }
details { margin: 10px 0; }
summary { cursor: pointer; padding: 6px 0; font-weight: 600; font-size: 14px; }
</style>
</head>
<body>
<h1>分區設定 <a id="backBtn" class="back-btn" href="#">← 回點單看板</a></h1>
<div class="hint">全域共用。點擊區名切換啟用（藍）/停用（灰），變更後按「儲存」生效。</div>

<h2>① 區清單</h2>
<div id="zones" class="zone-grid"></div>
<div class="toolbar">
  <span class="msg" id="zoneMsg"></span>
  <button id="saveBtn" class="primary" onclick="saveZones()" style="display:none">💾 儲存</button>
</div>

<h2>② 成員區對照</h2>
<details open>
<summary id="memSummary">載入中…</summary>
<table id="members">
  <thead><tr><th>姓名</th><th>LINE ID</th><th>區</th><th>上次出現</th><th>操作</th></tr></thead>
  <tbody></tbody>
</table>
</details>

<script>
let ZONES = [];
let ORIGINAL = '';
let MEMBERS = [];

function snapshot(zs) {
  return JSON.stringify(zs.map(z => [z.name, z.enabled ? 1 : 0]));
}

function updateDirty() {
  const btn = document.getElementById('saveBtn');
  btn.style.display = snapshot(ZONES) === ORIGINAL ? 'none' : '';
}

async function load() {
  const [z, m] = await Promise.all([
    fetch('/api/zones').then(r => r.json()),
    fetch('/api/members').then(r => r.json()),
  ]);
  ZONES = z.zones || [];
  ORIGINAL = snapshot(ZONES);
  MEMBERS = m.members || [];
  renderZones();
  renderMembers();
  updateDirty();
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
      updateDirty();
    });
  });
}

async function saveZones() {
  const r = await fetch('/api/zones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zones: ZONES }),
  });
  if (r.ok) {
    ORIGINAL = snapshot(ZONES);
    updateDirty();
    msg('已儲存 ✓');
    renderMembers();
  } else msg('儲存失敗', true);
}

async function deleteMember(user_id, name) {
  if (!window.confirm('確定刪除「' + name + '」？\\n（會一併清掉該帳號在進行中任務的點餐紀錄）')) return;
  const r = await fetch('/api/members', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id }),
  });
  if (r.ok) {
    MEMBERS = MEMBERS.filter(m => m.user_id !== user_id);
    renderMembers();
    msg('已刪除 ✓');
  } else {
    const t = await r.text();
    msg('刪除失敗：' + t, true);
  }
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
    const realName = m.real_name || '';
    const lineDisp = m.line_display || '';
    const dt = (m.last_seen_at || '').slice(0, 16);
    const isSynth = String(m.user_id || '').startsWith('zone:');
    const tr = document.createElement('tr');
    const optHtml = ['<option value="">（未分區）</option>', ...zonesOn.map(z => \`<option value="\${esc(z.name)}">\${esc(zoneLabel(z))}</option>\`)].join('');
    const delCell = isSynth ? '<td></td>' : \`<td><button class="del-mem" data-uid="\${esc(m.user_id)}" data-name="\${esc(realName || lineDisp)}" title="刪除此成員">×</button></td>\`;
    // 姓名欄：可編輯 input（real_name），底下小字顯示 LINE 暱稱（提示用）；isSynth 不可編輯
    const nameCell = isSynth
      ? \`<td>\${esc(realName || lineDisp || '(代點)')} <small style="color:#888">[代點]</small></td>\`
      : \`<td>
          <input class="name-edit" type="text" value="\${esc(realName)}" placeholder="\${esc(lineDisp || '請輸入真實姓名')}" data-uid="\${esc(m.user_id)}" style="width:90%;padding:4px 6px;font-size:13px;border:1px solid #ccc6;border-radius:4px;background:transparent;color:inherit">
          \${realName && lineDisp && realName !== lineDisp ? \`<br><small style="color:#888">LINE：\${esc(lineDisp)}</small>\` : ''}
        </td>\`;
    tr.innerHTML = \`
      \${nameCell}
      <td class="uid">\${esc(m.user_id)}</td>
      <td><select class="zone-pick">\${optHtml}</select></td>
      <td><small>\${esc(dt)}</small></td>
      \${delCell}\`;
    const sel = tr.querySelector('select');
    sel.value = m.zone || '';
    sel.addEventListener('change', () => tagMember(m.user_id, sel.value));
    const nameInput = tr.querySelector('.name-edit');
    if (nameInput) {
      nameInput.addEventListener('blur', async () => {
        const newName = nameInput.value.trim();
        if (newName === (realName || '')) return;
        nameInput.disabled = true;
        try {
          const r = await fetch('/api/members', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: m.user_id, real_name: newName }),
          });
          if (r.ok) {
            m.real_name = newName || null;
            msg('已更新姓名 ✓');
          } else msg('姓名更新失敗', true);
        } finally { nameInput.disabled = false; }
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      });
    }
    const btn = tr.querySelector('.del-mem');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '…';
        try { await deleteMember(btn.dataset.uid, btn.dataset.name); }
        finally { btn.disabled = false; btn.textContent = '×'; }
      });
    }
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

(function initBack() {
  const btn = document.getElementById('backBtn');
  const ref = document.referrer;
  if (ref && ref.indexOf('/t/') >= 0) btn.href = ref;
  else btn.onclick = (e) => { e.preventDefault(); history.back(); };
})();

load();
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
