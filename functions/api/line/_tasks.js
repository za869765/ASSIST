// 任務 (tasks) + 紀錄 (entries) 助手

export async function findOpenTask(DB, groupId) {
  if (!DB || !groupId) return null;
  const r = await DB.prepare(
    `SELECT id, task_name, mode, started_by, started_at
       FROM tasks WHERE group_id = ? AND status = 'open'
       ORDER BY id DESC LIMIT 1`
  ).bind(groupId).first();
  return r || null;
}

export async function findOpenTasks(DB, groupId) {
  if (!DB || !groupId) return [];
  const r = await DB.prepare(
    `SELECT id, task_name, mode, started_by, started_at
       FROM tasks WHERE group_id = ? AND status = 'open'
       ORDER BY id DESC`
  ).bind(groupId).all();
  return r.results || [];
}

export function matchTaskByHint(tasks, hint) {
  if (!hint) return null;
  const h = hint.trim();
  // exact
  const exact = tasks.find(t => t.task_name === h);
  if (exact) return exact;
  // contains
  const partial = tasks.find(t => t.task_name.includes(h) || h.includes(t.task_name));
  return partial || null;
}

export async function createTask(DB, { groupId, taskName, startedBy }) {
  const r = await DB.prepare(
    `INSERT INTO tasks (group_id, task_name, started_by) VALUES (?, ?, ?)`
  ).bind(groupId, taskName, startedBy).run();
  return r.meta.last_row_id;
}

export async function closeTask(DB, taskId) {
  await DB.prepare(
    `UPDATE tasks SET status = 'closed', closed_at = datetime('now') WHERE id = ?`
  ).bind(taskId).run();
}

// additive=false（預設）：以最新一次為主，覆蓋舊的 data/note/price
// additive=true：加點模式，把新 data 串接到舊 data 的「品項」欄，其他欄位以新為主
export async function upsertEntry(DB, { taskId, userId, data, note, price, rawText, additive = false }) {
  const old = await DB.prepare(
    `SELECT raw_texts, data_json, note, price FROM entries WHERE task_id = ? AND user_id = ?`
  ).bind(taskId, userId).first();
  const raws = old ? JSON.parse(old.raw_texts || '[]') : [];
  raws.push(rawText);

  let finalData = data;
  let finalNote = note || null;
  let finalPrice = price ?? null;

  if (additive && old) {
    const oldData = JSON.parse(old.data_json || '{}');
    const oldItem = oldData['品項'] || '';
    const newItem = data['品項'] || '';
    finalData = { ...oldData, ...data };
    if (oldItem && newItem && oldItem !== newItem) {
      finalData['品項'] = `${oldItem} + ${newItem}`;
    }
    finalNote = note ?? old.note ?? null;
    finalPrice = (price ?? 0) + (old.price || 0) || (price ?? old.price ?? null);
  }

  await DB.prepare(
    `INSERT INTO entries (task_id, user_id, data_json, note, price, raw_texts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       data_json = excluded.data_json,
       note      = excluded.note,
       price     = excluded.price,
       raw_texts = excluded.raw_texts,
       updated_at= datetime('now')`
  ).bind(taskId, userId, JSON.stringify(finalData), finalNote, finalPrice, JSON.stringify(raws)).run();
}

export async function listEntries(DB, taskId) {
  const r = await DB.prepare(
    `SELECT e.user_id, e.data_json, e.note, e.price, m.line_display, m.real_name
       FROM entries e
       LEFT JOIN members m ON m.user_id = e.user_id
      WHERE e.task_id = ?
      ORDER BY e.updated_at ASC`
  ).bind(taskId).all();
  return r.results || [];
}

export function summarizeEntries(entries) {
  if (!entries.length) return '（沒有任何紀錄）';
  const lines = entries.map((e, i) => {
    const name = e.real_name || e.line_display || e.user_id.slice(0, 6);
    const data = JSON.parse(e.data_json || '{}');
    const parts = Object.values(data).filter(Boolean).join(' / ');
    const price = e.price ? ` $${e.price}` : '';
    const note = e.note ? `（${e.note}）` : '';
    const body = parts || (e.note === '不吃' ? '不吃' : '(未辨識)');
    const noteShown = parts ? note : ''; // 不吃的情況 note 已經是主體，就不再括號
    return `${i + 1}. ${name}：${body}${price}${noteShown}`;
  });
  const totalPrice = entries.reduce((s, e) => s + (e.price || 0), 0);
  return lines.join('\n') + (totalPrice ? `\n\n合計：$${totalPrice}` : '');
}
