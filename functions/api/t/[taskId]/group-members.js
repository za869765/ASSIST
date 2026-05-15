// v1.0.49 列當前任務群組的成員（無 admin gate，看板下單 modal 用）
// GET /api/t/<taskId>/group-members
//   - per-group_members 優先（real_name + is_member），全域 members fallback
//   - 排除影子 web 身份（user_id 開頭 web:）
//   - 回傳：{ members: [{ user_id, real_name, line_display, is_member }] }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ env, params }) {
  const taskId = +params.taskId;
  if (!taskId) return json({ error: 'bad taskId' }, 400);

  const task = await env.DB.prepare(`SELECT id, group_id FROM tasks WHERE id = ?`).bind(taskId).first();
  if (!task) return json({ error: 'task not found' }, 404);
  if (!task.group_id) return json({ members: [] });

  // 取此群曾發過訊息（出現在 entries 表的 user_id）或在 group_members 表的 LINE 真人
  // per-group_members 優先，無 override 則 fallback 全域 members
  const r = await env.DB.prepare(`
    SELECT
      m.user_id,
      COALESCE(gm.real_name, m.real_name) AS real_name,
      m.line_display,
      m.is_member
    FROM members m
    LEFT JOIN group_members gm ON gm.group_id = ? AND gm.user_id = m.user_id
    WHERE m.user_id NOT LIKE 'web:%'
      AND m.user_id NOT LIKE 'zone:%'
      AND (
        m.user_id IN (SELECT DISTINCT user_id FROM entries WHERE task_id IN (SELECT id FROM tasks WHERE group_id = ?))
        OR gm.group_id IS NOT NULL
      )
    ORDER BY COALESCE(gm.real_name, m.real_name, m.line_display, m.user_id) ASC
  `).bind(task.group_id, task.group_id).all();

  const list = (r.results || []).map(m => ({
    user_id: m.user_id,
    real_name: m.real_name || null,
    line_display: m.line_display || null,
    is_member: !!m.is_member,
  }));
  return json({ members: list });
}
