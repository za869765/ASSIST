// 後台單一任務詳情：只讀，不改 status，純查看用
// GET /api/admin/tasks/<id>
import { requireAdminPass } from '../../line/_lib.js';

function deny() { return new Response('forbidden', { status: 403 }); }

export async function onRequestGet({ params, request, env }) {
  if (!requireAdminPass(request, env)) return deny();
  const id = parseInt(String(params.id || ''), 10);
  if (!id) return new Response('Bad id', { status: 400 });

  const task = await env.DB.prepare(`
    SELECT t.id, t.task_name, t.mode, t.status, t.started_at, t.closed_at,
           t.group_id, t.url_slug, g.alias AS group_alias,
           t.pricing_mode, t.total_amount, t.member_subsidy
      FROM tasks t
      LEFT JOIN groups g ON g.group_id = t.group_id
     WHERE t.id = ?
  `).bind(id).first();
  if (!task) return new Response('Not found', { status: 404 });

  // per-group 顯示：優先讀 group_members（該 task 所屬群組的設定），fallback 全域 members
  const entriesRow = await env.DB.prepare(`
    SELECT e.user_id, e.data_json, e.note, e.price, e.confirmed, e.updated_at,
           COALESCE(gm.real_name, m.real_name) AS real_name,
           m.line_display,
           COALESCE(gm.zone, m.zone)           AS zone
      FROM entries e
      LEFT JOIN group_members gm ON gm.group_id = ? AND gm.user_id = e.user_id
      LEFT JOIN members m         ON m.user_id  = e.user_id
     WHERE e.task_id = ?
     ORDER BY COALESCE(gm.zone, m.zone, '~'),
              COALESCE(gm.real_name, m.real_name, m.line_display, e.user_id),
              e.updated_at
  `).bind(task.group_id, id).all();

  const entries = (entriesRow.results || []).map(e => {
    let data = {};
    try { data = JSON.parse(e.data_json || '{}'); } catch {}
    // 名稱 fallback：real_name → line_display → data.姓名（看板 web 點單塞進 data_json）→ user_id 前 6 字
    const dataName = (data && (data['姓名'] || data.name)) || '';
    const name = e.real_name || e.line_display || dataName || (e.user_id || '').slice(0, 6);
    return {
      user_id: e.user_id,
      name,
      zone: e.zone || '',
      data,
      note: e.note || '',
      price: e.price || 0,
      confirmed: !!e.confirmed,
      updated_at: e.updated_at,
    };
  });

  const totalPrice = entries.reduce((s, e) => s + (e.price || 0), 0);
  const zoneCounts = {};
  for (const e of entries) {
    const z = e.zone || '(未分區)';
    zoneCounts[z] = (zoneCounts[z] || 0) + 1;
  }

  return Response.json({
    task: {
      id: task.id,
      task_name: task.task_name,
      mode: task.mode || 'free',
      status: task.status,
      started_at: task.started_at,
      closed_at: task.closed_at,
      group_id: task.group_id,
      group_alias: task.group_alias || '',
      url_slug: task.url_slug || '',
      pricing_mode: task.pricing_mode || 'free_bento',
      total_amount: task.total_amount,
      member_subsidy: task.member_subsidy,
    },
    entries,
    summary: {
      entry_count: entries.length,
      total_price: totalPrice,
      zone_counts: zoneCounts,
    },
  });
}
