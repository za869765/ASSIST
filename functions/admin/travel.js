// v1.0.64 會員旅遊 · 計算頁（獨立入口）：直接建立/挑選旅遊任務 → 進看板全頁計算
// 計算/報名/結算都在任務看板（/t/<slug>?admin=1）；綁 LINE 群可同步群報名。任務只是儲存/連動載體。
export async function onRequestGet() {
  const html = '<!DOCTYPE html>\n' +
'<html lang="zh-Hant"><head>\n' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'<title>會員旅遊 · 計算頁</title>\n' +
'<style>\n' +
':root{color-scheme:light dark}*{box-sizing:border-box}\n' +
'body{font-family:-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;max-width:760px;margin:0 auto;padding:20px 16px;line-height:1.5}\n' +
'h1{font-size:21px;margin:0 0 4px}.sub{color:#888;font-size:13px;margin-bottom:18px}\n' +
'.card{border:1px solid #ddd4;border-radius:10px;padding:16px 18px;margin-bottom:14px}\n' +
'label{font-size:13px;color:#607d8b;display:block;margin:8px 0 4px}\n' +
'input,select{width:100%;padding:8px 10px;font-size:15px;border:1px solid #ccc8;border-radius:6px;background:transparent;color:inherit}\n' +
'button{padding:9px 16px;font-size:14px;font-weight:600;border-radius:7px;border:1px solid #2db87a;background:#2db87a;color:#fff;cursor:pointer}\n' +
'button.ghost{background:transparent;color:#2db87a}\n' +
'button:disabled{opacity:.5;cursor:default}\n' +
'.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}.row>div{flex:1;min-width:160px}\n' +
'.msg{font-size:13px;color:#d4543a;margin-top:8px;min-height:18px}\n' +
'.tlist a{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;margin:8px 0;border:1px solid #ddd6;border-radius:8px;text-decoration:none;color:inherit}\n' +
'.tlist a:hover{border-color:#2db87a;background:#2db87a10}\n' +
'.tlist .nm{font-weight:600;font-size:15px}.tlist .meta{font-size:12px;color:#888}\n' +
'.pill{font-size:11px;background:#e8f5e9;color:#1b5e20;border-radius:10px;padding:2px 9px}\n' +
'.foot{color:#90a4ae;font-size:11px;margin-top:24px;text-align:center}\n' +
'.note{font-size:12px;color:#888;background:#f6f6f622;border-left:3px solid #2db87a;padding:8px 12px;border-radius:0 6px 6px 0;margin-top:6px}\n' +
'</style></head><body>\n' +
'<h1>🧳 會員旅遊 · 計算頁</h1>\n' +
'<div class="sub">建立或挑一個旅遊任務 → 進看板做完整計算（參數／報名／Excel／即時結算）。<a href="/admin">← 後台</a></div>\n' +
'<div id="passCard" class="card" style="display:none">\n' +
'  <label>管理密碼（ADMIN_PASS）</label>\n' +
'  <div class="row"><div><input id="passInput" type="password" placeholder="輸入後台密碼"></div><button id="passBtn">登入</button></div>\n' +
'  <div class="msg" id="passMsg"></div>\n' +
'</div>\n' +
'<div id="app" style="display:none">\n' +
'  <div class="card">\n' +
'    <strong>＋ 新建旅遊任務</strong>\n' +
'    <div class="note">綁 LINE 群可同步「群組報名」；不綁也能用（看板手填／Excel 匯入）。建立後直接進計算頁。</div>\n' +
'    <label for="tn">任務名稱</label><input id="tn" maxlength="40" placeholder="例：115年聯繫會北部旅遊">\n' +
'    <label for="grp">綁定 LINE 群（選填）</label><select id="grp"><option value="">— 不綁，純計算 —</option></select>\n' +
'    <div style="margin-top:12px"><button id="createBtn">建立並開始計算 →</button></div>\n' +
'    <div class="msg" id="createMsg"></div>\n' +
'  </div>\n' +
'  <div class="card">\n' +
'    <strong>進行中的旅遊任務</strong>\n' +
'    <div class="tlist" id="tlist"><div class="meta">載入中…</div></div>\n' +
'  </div>\n' +
'</div>\n' +
'<div class="foot">ASSIST · 會員旅遊計算頁 v1.0.68</div>\n' +
'<script>\n' +
'var PASS = localStorage.getItem("assist_admin_pass") || "";\n' +
'function show(el,on){document.getElementById(el).style.display = on ? "" : "none";}\n' +
'function api(path,opts){opts=opts||{};opts.headers=Object.assign({},opts.headers||{},{"X-Admin-Pass":PASS});if(opts.body&&!opts.headers["Content-Type"])opts.headers["Content-Type"]="application/json";return fetch(path,opts);}\n' +
'function esc(s){return String(s==null?"":s).replace(/[&<>\\"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];});}\n' +
'async function boot(){\n' +
'  if(!PASS){ show("passCard",true); show("app",false); return; }\n' +
'  var ok = await loadAll();\n' +
'  if(ok){ show("passCard",false); show("app",true); }\n' +
'  else { show("passCard",true); show("app",false); }\n' +
'}\n' +
'async function loadAll(){\n' +
'  try{\n' +
'    var gr = await api("/api/admin/groups");\n' +
'    if(gr.status===403) return false;\n' +
'    var gj = await gr.json();\n' +
'    var sel = document.getElementById("grp");\n' +
'    (gj.groups||[]).forEach(function(g){ var o=document.createElement("option"); o.value=g.group_id; o.textContent=(g.alias||g.group_id)+" ("+(g.open_count||0)+" 進行中)"; sel.appendChild(o); });\n' +
'    var tr = await api("/api/admin/tasks?status=open&limit=80");\n' +
'    var tj = await tr.json();\n' +
'    var travel = (tj.tasks||[]).filter(function(t){ return t.pricing_mode==="travel"; });\n' +
'    var box = document.getElementById("tlist");\n' +
'    if(!travel.length){ box.innerHTML = "<div class=\\"meta\\">目前沒有進行中的旅遊任務，請用上方新建。</div>"; }\n' +
'    else { box.innerHTML = travel.map(function(t){ return "<a href=\\"/t/"+esc(t.url_slug||t.id)+"?admin=1\\"><span class=\\"nm\\">"+esc(t.task_name)+"</span><span class=\\"meta\\">"+(t.group_alias?esc(t.group_alias)+" · ":"")+(t.entry_count||0)+" 人 <span class=\\"pill\\">旅遊</span> →</span></a>"; }).join(""); }\n' +
'    return true;\n' +
'  }catch(e){ return false; }\n' +
'}\n' +
'document.getElementById("passBtn").addEventListener("click",async function(){\n' +
'  var p = document.getElementById("passInput").value.trim();\n' +
'  if(!p){ document.getElementById("passMsg").textContent="請輸入密碼"; return; }\n' +
'  PASS = p;\n' +
'  var ok = await loadAll();\n' +
'  if(ok){ localStorage.setItem("assist_admin_pass",p); document.getElementById("passMsg").textContent=""; show("passCard",false); show("app",true); }\n' +
'  else { document.getElementById("passMsg").textContent="密碼錯誤或無法連線"; }\n' +
'});\n' +
'document.getElementById("passInput").addEventListener("keydown",function(e){ if(e.key==="Enter") document.getElementById("passBtn").click(); });\n' +
'document.getElementById("createBtn").addEventListener("click",async function(){\n' +
'  var btn=this, name=document.getElementById("tn").value.trim(), grp=document.getElementById("grp").value;\n' +
'  var msg=document.getElementById("createMsg");\n' +
'  if(!name){ msg.textContent="請填任務名稱"; return; }\n' +
'  btn.disabled=true; msg.style.color="#888"; msg.textContent="建立中…";\n' +
'  try{\n' +
'    var r = await api("/api/admin/travel-create",{method:"POST",body:JSON.stringify({taskName:name,groupId:grp})});\n' +
'    var j = await r.json();\n' +
'    if(!r.ok||!j.slug){ msg.style.color="#d4543a"; msg.textContent="建立失敗："+(j.error||r.status); btn.disabled=false; return; }\n' +
'    window.location.href = "/t/"+j.slug+"?admin=1";\n' +
'  }catch(e){ msg.style.color="#d4543a"; msg.textContent="錯誤："+e.message; btn.disabled=false; }\n' +
'});\n' +
'boot();\n' +
'</script></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
