// 菜單推薦 API：/api/menu/:taskId/recommend?dir=xxx
// 依照不同方向（輕食、不吃牛、素食、主食、飽足感 等）用 Gemini 挑 1–3 個品項
const DIRECTIONS = {
  light: '女性輕食 / 少油少重口味，熱量較低',
  no_beef: '不吃牛肉（排除所有牛料理）',
  vegan: '素食（無肉無海鮮）',
  staple: '主食取向：飯、麵、粥為主',
  filling: '飽足感優先，份量大或多配菜',
  spicy: '重口味 / 辣',
  value: 'C/P 值高：便宜又划算',
  healthy: '健康取向：蒸煮、少油炸',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function sha1Hex(s) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ env, params, request }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);
  const url = new URL(request.url);
  const dir = url.searchParams.get('dir') || 'light';
  const directive = DIRECTIONS[dir];
  if (!directive) return json({ error: 'bad dir', allowed: Object.keys(DIRECTIONS) }, 400);

  const task = await env.DB.prepare(
    `SELECT id, task_name, menu_json FROM tasks WHERE id = ?`
  ).bind(taskId).first();
  if (!task) return json({ error: 'task not found' }, 404);
  if (!task.menu_json) return json({ error: 'no menu' }, 400);
  const menu = JSON.parse(task.menu_json);
  if (!menu.length) return json({ error: 'empty menu' }, 400);

  // 取目前已點分布（供 AI 避開熱門 or 推薦人氣）
  const entries = await env.DB.prepare(
    `SELECT data_json FROM entries WHERE task_id = ?`
  ).bind(taskId).all();
  const orderMap = {};
  for (const e of (entries.results || [])) {
    try {
      const d = JSON.parse(e.data_json || '{}');
      const it = d['品項']; if (!it) continue;
      orderMap[it] = (orderMap[it] || 0) + 1;
    } catch {}
  }

  // 快取鍵：菜單內容 + 方向（分布不納入，避免每點一單都失效；分布只是給 AI 參考提高輸出品質）
  const key = await sha1Hex(task.menu_json + '|' + dir);
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS menu_recommend (key TEXT PRIMARY KEY, task_id INTEGER, dir TEXT, result TEXT, created_at TEXT)`
  ).run();
  const cached = await env.DB.prepare(
    `SELECT result, created_at FROM menu_recommend WHERE key = ?`
  ).bind(key).first();
  if (cached?.result) {
    const age = Date.now() - Date.parse(String(cached.created_at).replace(' ', 'T') + 'Z');
    if (!isNaN(age) && age < 30 * 60_000) {
      return json({ ...JSON.parse(cached.result), cached: true });
    }
  }

  if (!env.GEMINI_API_KEY) return json({ error: 'no gemini key' }, 500);
  const prompt = `你是餐廳推薦助手。以下菜單請依「${directive}」方向挑 1–3 個最合適的品項，給簡短推薦理由（每項 15 字內）。

菜單：${JSON.stringify(menu)}
目前大家點了：${JSON.stringify(orderMap)}

回傳 JSON 格式：
{"picks":[{"name":"品項全名","reason":"推薦理由"}],"note":"20 字內整體提醒（選填）"}

規則：
- picks 的 name 必須出自菜單（完整照抄）
- 找不到符合條件就回 {"picks":[],"note":"菜單上沒有符合的選項"}
- 不要加 markdown、不要多餘文字`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
  };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`;
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error('[recommend] http', r.status, err);
      return json({ error: 'gemini ' + r.status }, 500);
    }
    const j = await r.json();
    const txt = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    const parsed = JSON.parse(txt);
    const picks = Array.isArray(parsed?.picks) ? parsed.picks.map(p => ({
      name: String(p.name || '').trim(),
      reason: String(p.reason || '').trim(),
    })).filter(p => p.name) : [];
    const result = { picks, note: String(parsed?.note || '').trim(), dir, label: directive };
    await env.DB.prepare(
      `INSERT INTO menu_recommend (key, task_id, dir, result, created_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET result = excluded.result, created_at = excluded.created_at`
    ).bind(key, taskId, dir, JSON.stringify(result)).run();
    return json(result);
  } catch (e) {
    console.error('[recommend]', e);
    return json({ error: String(e).slice(0, 200) }, 500);
  }
}
