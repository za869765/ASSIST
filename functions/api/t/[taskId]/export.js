// 隨時匯出訂購清單 XLSX（不影響任務狀態）
// GET /api/t/:taskId/export → 直接回 xlsx bytes
import { buildXLSX } from '../../line/_xlsx.js';
import { buildSheetRows } from '../../line/webhook.js';
import { listEntries } from '../../line/_tasks.js';

export async function onRequestGet({ env, params }) {
  const taskId = +params.taskId;
  if (!taskId) return new Response('bad taskId', { status: 400 });
  const task = await env.DB.prepare(
    `SELECT id, task_name FROM tasks WHERE id = ?`
  ).bind(taskId).first();
  if (!task) return new Response('not found', { status: 404 });
  const entries = await listEntries(env.DB, taskId);
  const rows = buildSheetRows(task.task_name, entries);
  const bytes = buildXLSX(task.task_name.slice(0, 31) || 'sheet', rows);
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
