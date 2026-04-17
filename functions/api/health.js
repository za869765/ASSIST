// 健康檢查端點：確認 CF Pages + D1 binding 正常
export async function onRequestGet({ env }) {
  let dbOk = false;
  try {
    const r = await env.DB.prepare('SELECT 1 AS ok').first();
    dbOk = r?.ok === 1;
  } catch (e) { dbOk = false; }

  return new Response(JSON.stringify({
    service: 'ASSIST 小秘書',
    time: new Date().toISOString(),
    d1: dbOk ? 'ok' : 'fail',
    line_secret: !!env.LINE_CHANNEL_SECRET,
    line_token: !!env.LINE_CHANNEL_ACCESS_TOKEN,
    gemini_key: !!env.GEMINI_API_KEY,
    admin_count: String(env.ADMIN_USER_IDS || '').split(',').filter(Boolean).length,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
