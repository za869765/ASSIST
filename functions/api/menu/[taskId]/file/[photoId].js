// 取菜單照片原始檔（/api/menu/:taskId/file/:photoId）
export async function onRequestGet({ env, params }) {
  const taskId = +params.taskId;
  const photoId = params.photoId;
  if (!taskId || !photoId) return new Response('bad params', { status: 400 });
  if (!env.MENU_BUCKET) return new Response('no bucket', { status: 500 });
  const row = await env.DB.prepare(
    `SELECT r2_key, mime FROM menu_photos WHERE id = ? AND task_id = ?`
  ).bind(photoId, taskId).first();
  if (!row) return new Response('not found', { status: 404 });
  const obj = await env.MENU_BUCKET.get(row.r2_key);
  if (!obj) return new Response('missing', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.mime || 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
