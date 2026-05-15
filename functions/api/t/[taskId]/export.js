// 隨時匯出訂購清單 XLSX（不影響任務狀態）
// GET /api/t/:taskId/export → 直接回 xlsx bytes
import { buildXLSX } from '../../line/_xlsx.js';
import { buildSheetRows } from '../../line/webhook.js';
import { listEntries } from '../../line/_tasks.js';

export async function onRequestGet({ env, params }) {
  const taskId = +params.taskId;
  if (!taskId) return new Response('bad taskId', { status: 400 });
  // v1.0.58 含 buy5_get1 / shared_addon（容錯：migration 未跑時 fallback）
  let task;
  try {
    task = await env.DB.prepare(
      `SELECT id, task_name, mode, group_id, pricing_mode, total_amount, member_subsidy, buy5_get1, shared_addon FROM tasks WHERE id = ?`
    ).bind(taskId).first();
  } catch {
    task = await env.DB.prepare(
      `SELECT id, task_name, mode, group_id, pricing_mode, total_amount, member_subsidy FROM tasks WHERE id = ?`
    ).bind(taskId).first();
  }
  if (!task) return new Response('not found', { status: 404 });
  const entries = await listEntries(env.DB, taskId);
  // 撈 zone sort_order 給 buildSheetRows 排序
  const zoneRow = await env.DB.prepare(
    `SELECT name, sort_order FROM zones`
  ).all();
  const zoneOrder = {};
  for (const z of (zoneRow.results || [])) zoneOrder[z.name] = z.sort_order;
  // v1.0.46: 不分區群組 → XLSX 不顯示「區」欄
  let showZones = 1;
  if (task.group_id) {
    try {
      const g = await env.DB.prepare(`SELECT show_zones FROM groups WHERE group_id = ?`).bind(task.group_id).first();
      if (g && g.show_zones != null) showZones = +g.show_zones ? 1 : 0;
    } catch {}
  }
  // v1.0.58 讀 group_member_balance 給應付明細用（公平輪序排序）
  const balanceMap = new Map();
  if (task.group_id) {
    try {
      const br = await env.DB.prepare(
        `SELECT user_id, overpaid_count FROM group_member_balance WHERE group_id = ?`
      ).bind(task.group_id).all();
      for (const row of (br.results || [])) {
        balanceMap.set(row.user_id, +row.overpaid_count || 0);
      }
    } catch {}
  }
  const sheet = buildSheetRows(task.task_name, entries, {
    mode: task.mode, zoneOrder,
    pricing_mode: task.pricing_mode,
    total_amount: task.total_amount,
    member_subsidy: task.member_subsidy,
    showZones,
    buy5_get1: task.buy5_get1 ? 1 : 0,
    shared_addon: task.shared_addon == null ? 0 : Math.max(0, +task.shared_addon || 0),
    balanceMap,
  });
  const bytes = buildXLSX(task.task_name.slice(0, 31) || 'sheet', sheet.rows, sheet.mergeRanges);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = encodeURIComponent(`${task.task_name}_${stamp}.xlsx`);
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'no-store',
    },
  });
}
