// LINE Messaging API webhook 入口
// M1：簽章驗證 + 管理員白名單 + ping / whoami
// M3：群組任務模式（開始/進度/結單 + Gemini 抽欄位 + 非管理員訊息收集）
// 閒聊：非 M1/M3 指令的「秘書 xxx」→ Gemini 日常回應

import {
  verifyLineSignature, lineReply, isAdmin, isWakeword, stripWakeword,
  getGroupMemberProfile, getUserProfile,
} from './_lib.js';
import { geminiChat, geminiExtract, geminiIntent, geminiClassifyTask, geminiSplitTasks } from './_gemini.js';
import { buildXLSX } from './_xlsx.js';
import {
  findOpenTask, findOpenTasks, matchTaskByHint,
  createTask, closeTask, upsertEntry, listEntries, summarizeEntries,
} from './_tasks.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.text();
  const signature = request.headers.get('x-line-signature') || '';

  const valid = await verifyLineSignature(env.LINE_CHANNEL_SECRET, body, signature);
  if (!valid) return new Response('invalid signature', { status: 401 });

  const payload = JSON.parse(body);
  const events = payload.events || [];

  context.waitUntil(Promise.all(events.map(ev => handleEvent(ev, env).catch(e => {
    console.error('[event error]', e, ev);
  }))));

  return new Response('ok', { status: 200 });
}

async function handleEvent(ev, env) {
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const text = ev.message.text || '';
  const userId = ev.source.userId;
  const groupId = ev.source.groupId || null;
  const replyToken = ev.replyToken;

  if (userId) {
    await upsertMemberSighting(env.DB, userId, groupId, env.LINE_CHANNEL_ACCESS_TOKEN);
  }

  const admin = isAdmin(userId, env);
  const hasWake = isWakeword(text);

  // ─── 非喚醒訊息：只有群組 + 該群有 open task 時收集 ───
  if (!hasWake) {
    if (!groupId) return;
    const tasks = await findOpenTasks(env.DB, groupId);
    if (!tasks.length) return;

    // 管理員若處於「多任務結算等待選擇」狀態，這則訊息直接當作任務名稱
    if (admin) {
      // 清除 2 分鐘前的過期紀錄
      await env.DB.prepare(`DELETE FROM pending_close WHERE created_at < datetime('now','-2 minutes')`).run();
      const pc = await env.DB.prepare(
        `SELECT 1 FROM pending_close WHERE group_id = ? AND admin_id = ?`
      ).bind(groupId, userId).first();
      if (pc) {
        const t0 = text.trim();
        const allHit = /^(全部|都|兩個都|所有|都要|都結|全結|全部結算|都結算|兩個|三個|四個|五個)(結算|結單|結|算|吧|喔|啦|。|\.)*$/.test(t0.replace(/\s+/g, ''));
        const hit = matchTaskByHint(tasks, t0);
        await env.DB.prepare(`DELETE FROM pending_close WHERE group_id = ? AND admin_id = ?`).bind(groupId, userId).run();
        if (allHit) {
          let rt = replyToken;
          for (const tk of tasks) {
            await doCloseTask(env, tk, rt);
            rt = `push:${groupId}`; // 第 2 筆以後改 push
          }
          return;
        }
        if (hit) {
          await doCloseTask(env, hit, replyToken);
          return;
        }
        // 沒匹配 → 當作取消，繼續走正常流程
      }
    }

    // 管理員直接問「進度」等（不用喚醒詞）
    const progShort = String(text || '').replace(/[?？!！。.\s]/g, '');
    if (admin && /^(進度|目前|狀態|現況|收到幾筆|幾筆了)(.*)?$/.test(progShort)) {
      const hintText = progShort.replace(/^(進度|目前|狀態|現況|收到幾筆|幾筆了)/, '').trim();
      await doProgressReport(env, tasks, hintText, replyToken);
      return;
    }

    // admin 進度三件套：催 / 等 / 匯出
    if (admin && /^(催|催單|催餐|催一下|提醒|提醒一下)[\s!?！？。.~～]*$/.test(progShort)) {
      await doRemindMissing(env, tasks, replyToken);
      return;
    }
    if (admin && /^(匯出|匯出清單|下載|下載清單|XLSX|xlsx|excel|EXCEL|Excel)[\s!?！？。.~～]*$/.test(progShort)) {
      await doExportInProgress(env, tasks, replyToken);
      return;
    }
    if (admin && /^(等|繼續等|再等|等一下|稍等)[\s!?！？。.~～]*$/.test(progShort)) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '👌 OK，繼續等～有需要催再跟我說「催」' }]);
      return;
    }

    // 管理員「全部結算 / 兩個都結算 / 都結」→ 一次結掉所有 open tasks
    const allShort = String(text || '').replace(/[?？!！。.\s]/g, '');
    if (admin && /^(全部|都|兩個都|兩個|三個|四個|五個|所有|都要)(結算|結單|結|算)(吧|喔|啦)?$/.test(allShort)) {
      await env.DB.prepare(`DELETE FROM pending_close WHERE group_id = ? AND admin_id = ?`).bind(groupId, userId).run();
      let rt = replyToken;
      for (const tk of tasks) {
        await doCloseTask(env, tk, rt);
        rt = `push:${groupId}`;
      }
      return;
    }

    // 管理員直接講「結算 / 結單 / 收單」等（不用喚醒詞）→ 結單流程
    const closeShort = String(text || '').replace(/[?？!！。.\s]/g, '');
    if (admin && /^(結單|結算|結束|關閉|收單|結束統計|結單吧|關閉統計|收工|收了|打烊)(.*)?$/.test(closeShort)) {
      const hintText = closeShort.replace(/^(結單|結算|結束|關閉|收單|結束統計|結單吧|關閉統計|收工|收了|打烊)/, '').trim();
      const hinted = hintText ? matchTaskByHint(tasks, hintText) : null;
      const picked = hinted || (tasks.length === 1 ? tasks[0] : null);
      if (!picked) {
        const names = tasks.map(t => `「${t.task_name}」`).join('、');
        await env.DB.prepare(
          `INSERT INTO pending_close (group_id, admin_id, created_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(group_id, admin_id) DO UPDATE SET created_at = datetime('now')`
        ).bind(groupId, userId).run();
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text', text: `目前有多個任務：${names}\n要結算哪個?`,
        }]);
        return;
      }
      await doCloseTask(env, picked, replyToken);
      return;
    }

    // 管理員切換菜單/自由模式（保留 menu_json，只改 mode 旗標）
    if (admin) {
      const tText = text.trim();
      const toFree = /^(無菜單|自由|自由模式|關閉菜單|解除菜單)[\s!?！？。.~～]*$/.test(tText);
      const toMenu = /^(啟用菜單|菜單模式|開啟菜單|恢復菜單)[\s!?！？。.~～]*$/.test(tText);
      if (toFree || toMenu) {
        const newMode = toFree ? 'free' : 'menu';
        const targets = tasks.filter(t => t.menu_json);
        for (const t of targets) {
          await env.DB.prepare(`UPDATE tasks SET mode = ? WHERE id = ?`).bind(newMode, t.id).run();
        }
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text',
          text: targets.length
            ? `✅ 已切換為${toFree ? '自由' : '菜單'}模式（${targets.map(t => t.task_name).join('、')}）`
            : '（目前沒有含菜單的任務）',
        }]);
        return;
      }
    }

    // 管理員「菜單」→ PO 菜單照（每分鐘最多 1 次）
    if (admin && /^菜單[\s!?！？。.~～]*$/.test(text.trim())) {
      const all = [];
      for (const t of tasks) {
        if (!t.menu_json) continue;
        const msgs = await maybeMenuMessages(env, t);
        all.push(...msgs);
        if (all.length >= 5) break;
      }
      if (all.length) {
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, all.slice(0, 5));
      } else {
        const any = tasks.some(t => t.menu_json);
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text',
          text: any ? '📷 菜單剛 PO 過，請稍候（每分鐘最多 1 次）' : '📷 目前沒有菜單照片',
        }]);
      }
      return;
    }

    // 本人裸「請假/不吃」→ 套用到自己
    const bareLeave = text.trim().match(/^(?:今天|今日|本日)?\s*(請假|休假|不吃|沒訂|跳過|不訂|沒點|不出席|不參加|缺席|沒辦法出席|不能出席|我請假|我不吃|我沒訂|我不出席)[\s!?！？。.~～]*$/);
    if (bareLeave) {
      const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
      const selfName = m?.real_name || m?.line_display || userId.slice(0, 6);
      for (const t of tasks) {
        await upsertEntry(env.DB, {
          taskId: t.id, userId, data: {}, note: '請假', price: null, rawText: text, additive: false,
        });
      }
      // 順手清掉這人 pending_profanity（避免後續被誤擋）
      await env.DB.prepare(`DELETE FROM pending_profanity WHERE user_id = ?`).bind(userId).run();
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
        type: 'text', text: `📝 已登記「${selfName}」請假（${tasks.map(t => t.task_name).join('、')}）`,
      }]);
      return;
    }

    // 「某區請假/不吃/沒訂」或「某人請假」或「某區 某人 請假」→ 套用到所有開啟中的任務
    const leaveMatch = text.trim().match(/^(.{1,20}?)\s*(請假|休假|不吃|沒訂|跳過|不訂|沒點|不出席|不參加|缺席|不能出席|沒辦法出席)$/);
    if (leaveMatch) {
      // 名字/區前綴只認 admin；非 admin 只能用裸「請假」（bareLeave 已處理）
      let leave = admin ? await tryZoneLeave(env, userId, text) : null;
      let leaveLabel = leave?.zoneName;
      let leaveTargetId = leave?.userId;
      if (!leave && admin) {
        // 嘗試人名（或「區 名字」）比對 members
        let prefix = leaveMatch[1].trim();
        // 如果前綴是「<zone> <name>」，剝掉 zone
        const zoneRow = await env.DB.prepare(
          `SELECT name FROM zones WHERE enabled = 1 ORDER BY length(name) DESC`
        ).all();
        for (const z of (zoneRow.results || [])) {
          if (prefix.startsWith(z.name)) { prefix = prefix.slice(z.name.length).trim(); break; }
        }
        if (prefix) {
          // 名字比對：去掉 emoji/空白/標點後再比（處理「🌲 倖妤」這類含圖案的名字）
          const normName = (s) => String(s || '')
            .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, '')
            .replace(/[\s·・\.、,，!！?？]+/g, '')
            .trim();
          const pfx = normName(prefix);
          const allMembers = await env.DB.prepare(
            `SELECT user_id, real_name, line_display, zone, last_seen_at FROM members
             WHERE user_id NOT LIKE 'zone:%'
             ORDER BY last_seen_at DESC`
          ).all();
          let person = null;
          for (const r of (allMembers.results || [])) {
            if (normName(r.real_name) === pfx || normName(r.line_display) === pfx) { person = r; break; }
          }
          if (person) {
            leaveTargetId = person.user_id;
            leaveLabel = person.real_name || person.line_display || prefix;
            leave = { userId: leaveTargetId, zoneName: leaveLabel };
          }
        }
      }
      if (leave) {
        for (const t of tasks) {
          await upsertEntry(env.DB, {
            taskId: t.id, userId: leaveTargetId,
            data: {}, note: '請假', price: null, rawText: text, additive: false,
          });
        }
        await env.DB.prepare(`DELETE FROM pending_profanity WHERE user_id = ?`).bind(leaveTargetId).run();
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text', text: `📝 已登記「${leaveLabel}」請假（${tasks.map(t => t.task_name).join('、')}）`,
        }]);
        return;
      }
    }

    // 「<名字> 刪除<任務>」「<任務>刪除」「取消便當」→ 刪該人該任務的紀錄
    const delMatch = text.trim().match(/^(?:(.{1,20}?)\s+)?(刪除|刪掉|取消|移除|清除|不要)\s*(.{1,10})$/);
    if (delMatch) {
      const personHint = (delMatch[1] || '').trim();
      const taskHint = (delMatch[3] || '').trim();
      const pickedTask = matchTaskByHint(tasks, taskHint);
      if (pickedTask) {
        let uid = userId;
        let label = '';
        if (personHint && admin) {
          const proxy = await tryProxyZone(env, userId, personHint);
          if (proxy && !proxy.multi) { uid = proxy.userId; label = `「${personHint}」`; }
          else {
            const p2 = await tryProxyPerson(env, userId, personHint);
            if (p2) { uid = p2.userId; label = `「${personHint}」`; }
          }
        }
        const result = await env.DB.prepare(
          `DELETE FROM entries WHERE task_id = ? AND user_id = ?`
        ).bind(pickedTask.id, uid).run();
        await env.DB.prepare(`DELETE FROM pending_dups WHERE task_id = ? AND user_id = ?`).bind(pickedTask.id, uid).run();
        await env.DB.prepare(`DELETE FROM pending_profanity WHERE user_id = ?`).bind(uid).run();
        const hit = result.meta?.changes || 0;
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text', text: hit ? `🗑 已刪除${label}「${pickedTask.task_name}」紀錄` : `找不到${label}「${pickedTask.task_name}」的紀錄`,
        }]);
        return;
      }
    }

    // 「飲料不用 / 便當不用」→ 針對該任務記請假（可 admin 代點區 或 本人）
    const skipMatch = text.trim().match(/^(.{1,10}?)\s*(不用了?|不要了?|免了?|跳過|不需要)$/);
    if (skipMatch) {
      const hint = skipMatch[1].trim();
      const pickedTask = matchTaskByHint(tasks, hint);
      if (pickedTask) {
        let uid = userId;
        let who = '';
        if (admin) {
          const proxy = await tryProxyZone(env, userId, hint);
          if (proxy && !proxy.multi) { uid = proxy.userId; who = `「${hint}」`; }
        }
        await upsertEntry(env.DB, {
          taskId: pickedTask.id, userId: uid,
          data: {}, note: '請假', price: null, rawText: text, additive: false,
        });
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text', text: `📝 已登記${who}「${pickedTask.task_name}」請假`,
        }]);
        return;
      }
    }

    let target = tasks[0];
    if (tasks.length > 1) {
      // 若此人正在任一任務中有 pending_dup 且訊息是加/改裁示 → 優先導向該任務
      let routed = false;
      const v = normalizeVerdict(text);
      if (v === '加' || v === '改') {
        const ids = tasks.map(t => t.id);
        const placeholders = ids.map(() => '?').join(',');
        const pendingTask = await env.DB.prepare(
          `SELECT task_id FROM pending_dups WHERE user_id = ? AND task_id IN (${placeholders}) LIMIT 1`
        ).bind(userId, ...ids).first();
        if (pendingTask) {
          target = tasks.find(t => t.id === pendingTask.task_id) || tasks[0];
          routed = true;
        }
      }
      if (!routed) {
        const names = tasks.map(t => t.task_name);
        // 先試著拆分：若訊息橫跨多個任務（例「雞腿便當 檸檬綠」）→ 各任務各收一筆
        const segments = await geminiSplitTasks(env.GEMINI_API_KEY, names, text);
        const validSegs = (segments || [])
          .map(s => ({ task: matchTaskByHint(tasks, s.task_name), seg: (s.text || '').trim() }))
          .filter(x => x.task && x.seg);
        const uniqTaskIds = new Set(validSegs.map(x => x.task.id));
        if (validSegs.length >= 2 && uniqTaskIds.size >= 2) {
          // 不用 push → 只處理第一段，其他段落請使用者分開再發一次
          const { task: firstTask, seg: firstSeg } = validSegs[0];
          const others = validSegs.slice(1).map(x => `${x.task.task_name}：「${x.seg}」`).join('\n');
          await collectEntry(env, firstTask, userId, firstSeg, replyToken, groupId);
          // 提示訊息只在 log，不再發 push；使用者看到第一段被處理後，可自己再發下一段
          console.log('[multi-seg] skip others (no-push policy):', others);
          return;
        }
        const { task_name } = await geminiClassifyTask(env.GEMINI_API_KEY, names, text);
        const picked = (task_name ? matchTaskByHint(tasks, task_name) : null) || tasks[0];
        target = picked;
      }
    }
    await collectEntry(env, target, userId, text, replyToken, groupId);
    return;
  }

  // ─── 喚醒訊息 ───
  const cmd = stripWakeword(text);

  // 自助查 userId（所有人可用）
  if (/^我的\s*ID$/i.test(cmd) || /whoami/i.test(cmd)) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `您的 userId：\n${userId}\n\n請把這組字串給管理員加入白名單。` },
    ]);
    return;
  }

  // 非管理員 → 完全靜默
  if (!admin) return;

  // ping
  if (/^ping$/i.test(cmd)) {
    const adminCount = String(env.ADMIN_USER_IDS || '').split(',').filter(Boolean).length;
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `🟢 pong\n管理員：${adminCount} 人\nuserId：${userId}\ngroupId：${groupId || '(私聊)'}` },
    ]);
    return;
  }

  if (!cmd) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '在的，有什麼事嗎？' }]);
    return;
  }

  // 短關鍵字 fast-path（不用跑 Gemini）
  const cmdShort = cmd.replace(/[?？!！。.\s]/g, '');
  let fast = null;
  if (/^(進度|目前|狀態|現況|收到幾筆|幾筆了)$/.test(cmdShort)) fast = { intent: 'progress' };
  else if (/^(結單|結算|結束|關閉|收單|結束統計|結單吧|關閉統計|收工|收了|打烊)$/.test(cmdShort)) fast = { intent: 'close' };

  // ─── Gemini 意圖辨識（start_task / progress / close / chat）───
  const { intent, task_name: taskNameRaw, confidence } =
    fast ? { ...fast, confidence: 'high', task_name: null }
         : await geminiIntent(env.GEMINI_API_KEY, cmd);
  // confidence 不是 high 就當 chat 處理（避免誤判啟動任務）
  const doIt = confidence === 'high' || confidence === 'mid';

  if (doIt && intent === 'start_task') {
    const taskName = (taskNameRaw || '').trim();
    if (!taskName) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '要統計什麼主題？' }]);
      return;
    }
    if (!groupId) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '統計任務請在群組使用' }]);
      return;
    }
    const openTasks = await findOpenTasks(env.DB, groupId);
    const dup = openTasks.find(t => t.task_name === taskName);
    if (dup) {
      const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
      const url = `${base}/t/${dup.url_slug || dup.id}`;
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `「${taskName}」已經在進行中\n即時看板：${url}` }]);
      return;
    }
    const created = await createTask(env.DB, { groupId, taskName, startedBy: userId });
    const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
    const viewUrl = `${base}/t/${created.slug}`;
    const sibling = openTasks.length
      ? `\n(同時進行中：\n${openTasks.map(t => `・${t.task_name}：${base}/t/${t.url_slug || t.id}`).join('\n')})` : '';
    const hint = confidence === 'mid' ? '\n(若不是這個意思，請再講清楚或「秘書 結單」取消)' : '';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `📝 開始統計「${taskName}」，請大家直接回覆\n即時看板：${viewUrl}${sibling}${hint}` },
    ]);
    return;
  }

  if (doIt && intent === 'progress' && groupId) {
    const tasks = await findOpenTasks(env.DB, groupId);
    if (!tasks.length) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '目前沒有進行中的任務' }]);
      return;
    }
    await doProgressReport(env, tasks, taskNameRaw || '', replyToken);
    return;
  }

  if (doIt && intent === 'close' && groupId) {
    const tasks = await findOpenTasks(env.DB, groupId);
    if (!tasks.length) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '目前沒有進行中的任務' }]);
      return;
    }
    const hinted = taskNameRaw ? matchTaskByHint(tasks, taskNameRaw) : null;
    const picked = hinted || (tasks.length === 1 ? tasks[0] : null);
    if (!picked) {
      const names = tasks.map(t => `「${t.task_name}」`).join('、');
      await env.DB.prepare(
        `INSERT INTO pending_close (group_id, admin_id, created_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(group_id, admin_id) DO UPDATE SET created_at = datetime('now')`
      ).bind(groupId, userId).run();
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `目前有多個任務：${names}\n要結算哪個?` }]);
      return;
    }
    await doCloseTask(env, picked, replyToken);
    return;
  }

  // 秘書 裁定 <名字> 收/問/略（或口語）
  const verdict = cmd.match(/^裁定\s+(\S+)\s+(.+)$/);
  if (verdict && groupId) {
    const action = normalizeVerdict(verdict[2]);
    if (action) {
      await handleVerdict(env, groupId, verdict[1], action, replyToken);
      return;
    }
  }

  // ─── 群組內無進行中任務 → 保持靜默（避免未開任務時亂答）
  if (groupId) {
    const openTasks = await findOpenTasks(env.DB, groupId);
    if (!openTasks.length) return;
  }

  // ─── 其他一律閒聊 ───
  const reply = await geminiChat(env.GEMINI_API_KEY, cmd);
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

async function doProgressReport(env, tasks, hintText, replyToken) {
  const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
  // 預先撈一次啟用 zones（排除衛生局：駐點區不限人數，不算「衛生所要喊」對象）
  const zoneRow = await env.DB.prepare(
    `SELECT name FROM zones WHERE enabled = 1 AND name != '衛生局' ORDER BY sort_order ASC, name ASC`
  ).all();
  const allZones = (zoneRow.results || []).map(z => z.name);
  const missingFor = (entries) => {
    const filled = new Set(entries.filter(e => e.zone).map(e => e.zone));
    const missing = allZones.filter(z => !filled.has(z));
    if (!allZones.length) return '';
    return missing.length
      ? `\n⏳ 還沒喊（${missing.length}/${allZones.length}）：${missing.join('、')}`
      : `\n✓ 全部 ${allZones.length} 區衛生所已喊`;
  };

  const askLine = '\n\n💬 請回：「催」群組催未回覆者／「等」繼續等／「匯出」下載目前清單';

  const hinted = hintText ? matchTaskByHint(tasks, hintText) : null;
  const picked = hinted || (tasks.length === 1 ? tasks[0] : null);
  if (!picked) {
    const blocks = [];
    for (const t of tasks) {
      const entries = await listEntries(env.DB, t.id);
      const url = `${base}/t/${t.url_slug || t.id}`;
      blocks.push(`📊「${t.task_name}」(${entries.length} 筆)\n看板：${url}${missingFor(entries)}\n\n${summarizeEntries(entries)}`);
    }
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: blocks.join('\n\n———\n\n') + askLine }]);
    return;
  }
  const entries = await listEntries(env.DB, picked.id);
  const url = `${base}/t/${picked.url_slug || picked.id}`;
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
    { type: 'text', text: `📊 任務「${picked.task_name}」目前 ${entries.length} 筆\n看板：${url}${missingFor(entries)}\n\n${summarizeEntries(entries)}${askLine}` },
  ]);
}

// admin 進度三件套：催 / 等 / 匯出
// 「催」會用 LINE mention API 真的 @ 該區已 tag 的成員（要先在 admin/zones 把人對到區）
async function doRemindMissing(env, tasks, replyToken) {
  const zoneRow = await env.DB.prepare(
    `SELECT name FROM zones WHERE enabled = 1 AND name != '衛生局' ORDER BY sort_order ASC, name ASC`
  ).all();
  const allZones = (zoneRow.results || []).map(z => z.name);
  const filled = new Set();
  for (const t of tasks) {
    const entries = await listEntries(env.DB, t.id);
    entries.forEach(e => { if (e.zone) filled.add(e.zone); });
  }
  const missing = allZones.filter(z => !filled.has(z));
  if (!missing.length) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: '✓ 全部衛生所都已回覆，不用催了 👍' }]);
    return;
  }

  // 對每個 missing zone 收集：
  //   1) 已 tag 到該區的真人（曾在群組發過話，bot 有 user_id 可 mention）
  //   2) 沒 tag 但 roster 預載該區真名（bot 無 user_id，只能純文字提示）
  const perZone = [];
  for (const z of missing) {
    const rs = await env.DB.prepare(
      `SELECT user_id, real_name, line_display FROM members
        WHERE zone = ? AND user_id NOT LIKE 'zone:%' ORDER BY last_seen_at DESC`
    ).bind(z).all();
    const members = rs.results || [];
    let rosterNames = [];
    if (!members.length) {
      try {
        const rr = await env.DB.prepare(
          `SELECT real_name FROM roster WHERE zone = ? AND user_id IS NULL ORDER BY id`
        ).bind(z).all();
        rosterNames = (rr.results || []).map(r => r.real_name).filter(Boolean);
      } catch {}
    }
    perZone.push({ zone: z, members, rosterNames });
  }

  // 組訊息＋mention 物件（index 用 JS string length = UTF-16 code units，與 LINE 規範一致）
  let text = `📣 提醒：以下 ${missing.length} 區衛生所還沒回覆～\n\n`;
  const mentionees = [];
  let untaggedCount = 0;
  for (const { zone, members, rosterNames } of perZone) {
    if (members.length) {
      // 有 user_id → 真的 @
      let line = '• ';
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const display = m.real_name || m.line_display || zone;
        const tag = '@' + display;
        if (i > 0) line += ' ';
        const idxInText = text.length + line.length;
        mentionees.push({ index: idxInText, length: tag.length, type: 'user', userId: m.user_id });
        line += tag;
      }
      line += `（${zone}）\n`;
      text += line;
    } else if (rosterNames.length) {
      // 沒 user_id 但 roster 有預載真名 → 純文字提示
      text += `• ${zone}（${rosterNames.join('、')}，請主動回覆）\n`;
      untaggedCount++;
    } else {
      // 完全沒資料
      text += `• ${zone}（待指派）\n`;
      untaggedCount++;
    }
  }
  if (untaggedCount > 0) {
    text += `\n⚠️ 標 ★ 的 ${untaggedCount} 區因該成員從未在此群組發過話，bot 無法 @ 推播；請該員主動點餐／請假。`;
  }
  // 無菜單便當：禮貌提醒葷／素選項
  const hasFreeTask = tasks.some(t => t.mode === 'free');
  if (hasFreeTask) {
    text += '\n\n🍱 請問各位是「葷食便當」還是「素食便當」呢？\n　 有吃素的同仁可直接回「素」～\n　 若不吃也請告訴我們「請假」，謝謝大家 🙏';
  } else {
    text += '\n📝 回覆範例：「葷」「素」「請假」「+1」';
  }

  const msg = { type: 'text', text };
  if (mentionees.length) msg.mention = { mentionees };
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [msg]);
}

async function doExportInProgress(env, tasks, replyToken) {
  const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
  const lines = tasks.map(t => `📊「${t.task_name}」\n${base}/api/t/${t.url_slug || t.id}/export`);
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
    type: 'text', text: `📥 進行中清單下載（XLSX）：\n\n${lines.join('\n\n')}\n\n（任務尚未結單，僅匯出當前狀態）`,
  }]);
}

async function doCloseTask(env, picked, replyToken) {
  // 結單前：未回應的 pending_dups 預設視為「更改」，全部套用
  const pendingRows = await env.DB.prepare(
    `SELECT user_id, new_text, new_data, new_note, new_price FROM pending_dups WHERE task_id = ?`
  ).bind(picked.id).all();
  for (const p of (pendingRows.results || [])) {
    await upsertEntry(env.DB, {
      taskId: picked.id, userId: p.user_id,
      data: JSON.parse(p.new_data || '{}'),
      note: p.new_note, price: p.new_price, rawText: p.new_text,
      additive: false,
    });
  }
  await env.DB.prepare(`DELETE FROM pending_dups WHERE task_id = ?`).bind(picked.id).run();
  await env.DB.prepare(`DELETE FROM pending_profanity WHERE task_id = ?`).bind(picked.id).run();

  const entries = await listEntries(env.DB, picked.id);
  await closeTask(env.DB, picked.id, env.MENU_BUCKET);

  // 撈 zone sort_order 給 buildSheetRows 排序（衛生局 → 在局 → 一般衛生所 sort_order）
  const zoneRow = await env.DB.prepare(`SELECT name, sort_order FROM zones`).all();
  const zoneOrder = {};
  for (const z of (zoneRow.results || [])) zoneOrder[z.name] = z.sort_order;
  const rows = buildSheetRows(picked.task_name, entries, { mode: picked.mode, zoneOrder });
  const bytes = buildXLSX(picked.task_name.slice(0, 31) || 'sheet', rows);
  const token = genDownloadToken();
  const filename = `${picked.task_name}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // 下載 token：24 小時到期，可多人重複下載
  const expiresDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expiresISO = expiresDate.toISOString().replace('T', ' ').slice(0, 19);
  await env.DB.prepare(
    `INSERT INTO exports (token, task_id, filename, content_type, blob, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(token, picked.id, filename, contentType, bytes, expiresISO).run();

  const base = env.PUBLIC_BASE_URL || 'https://assist-gcl.pages.dev';
  const dlUrl = `${base}/d/${token}`;
  const aggText = buildAggregateText(picked.task_name, entries);
  const tpeExpire = new Date(expiresDate.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');

  // 未分區名單（提醒管理員）
  const unassigned = entries.filter(e => !e.zone).map(e => e.real_name || e.line_display || (e.user_id || '').slice(0, 6));
  const unassignedLine = unassigned.length
    ? `\n\n⚠️ 未分區（${unassigned.length} 人）：${unassigned.join('、')}\n→ /admin/zones 可手動分區`
    : '';

  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
    { type: 'text', text: `✅ 任務「${picked.task_name}」已結單\n\n${aggText}${unassignedLine}\n\n📎 完整明細下載：\n${dlUrl}\n⏰ 連結在 ${tpeExpire}（台北時間）前有效，可多人重複下載` },
  ]);
}

async function collectEntry(env, task, userId, text, replyToken, groupId) {
  // 先檢查是否在回應「挑候選品項」的編號提示
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pending_menu_pick (task_id INTEGER, user_id TEXT, candidates TEXT, created_at TEXT, PRIMARY KEY(task_id, user_id))`
  ).run();
  {
    const pendRow = await env.DB.prepare(
      `SELECT candidates, created_at FROM pending_menu_pick WHERE task_id = ? AND user_id = ?`
    ).bind(task.id, userId).first();
    if (pendRow?.candidates) {
      const age = Date.now() - Date.parse(String(pendRow.created_at).replace(' ', 'T') + 'Z');
      if (!isNaN(age) && age < 5 * 60_000) {
        const cands = JSON.parse(pendRow.candidates);
        const raw = String(text || '').trim();
        let chosen = null;
        // A) 純數字序號：3 / 第3 / 3號
        const pickMatch = raw.match(/^(?:第\s*)?([1-9]\d?)(?:\s*號|\s*項)?[\s!?！？。.~～]*$/);
        if (pickMatch) {
          const idx = +pickMatch[1] - 1;
          if (idx >= 0 && idx < cands.length) chosen = cands[idx];
        }
        // B) 中文關鍵字：只要 raw 能唯一命中某候選的名稱（子字串雙向）
        if (!chosen && raw.length >= 1) {
          const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
          const target = norm(raw);
          const hits = cands.filter(c => {
            const n = norm(c.name);
            return n && (n.includes(target) || target.includes(n));
          });
          if (hits.length === 1) chosen = hits[0];
        }
        if (chosen) {
          await env.DB.prepare(`DELETE FROM pending_menu_pick WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
          text = chosen.name;
        }
      }
    }
  }

  // 管理員標「請假」：「新化請假」「北區不吃」→ 該區記 請假，不再追問
  const leave = await tryZoneLeave(env, userId, text);
  if (leave) {
    await upsertEntry(env.DB, {
      taskId: task.id, userId: leave.userId,
      data: {}, note: '請假', price: null, rawText: text, additive: false,
    });
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
      { type: 'text', text: `📝 已登記「${leave.zoneName}」請假` },
    ]);
    return;
  }

  // 管理員代點：「幫南區點素食便當」「永康要一個排骨飯」等，把名字記成該區
  // 先剝掉 admin 代點常用的動作詞前綴（幫/替/代/請/幫忙），避免擋到名字比對
  const isAdminUser = isAdmin(userId, env);
  if (isAdminUser) {
    const stripped = text.replace(/^\s*(幫忙|幫|替|代|請)\s*/u, '');
    if (stripped !== text && stripped.trim().length >= 2) text = stripped;
  }
  const proxy = await tryProxyZone(env, userId, text);
  if (proxy?.multi) {
    // 多區自動拆分：依每個區名在文字中的位置切成片段，各自當成該區的點餐內容
    const zones = proxy.multi;
    const positions = zones
      .map(z => ({ zone: z, start: text.indexOf(z), end: text.indexOf(z) + z.length }))
      .filter(p => p.start >= 0)
      .sort((a, b) => a.start - b.start);
    const stripLead = (s) => s.replace(/^[\s跟和與,，、；的,]+/, '').trim();
    const prefix = stripLead(text.slice(0, positions[0].start));
    const segments = positions.map((p, i) => {
      const nextStart = i + 1 < positions.length ? positions[i + 1].start : text.length;
      return stripLead(text.slice(p.end, nextStart));
    });
    // 選一段當 fallback（當某區片段太短 → 表示「各一個…」的共用語意，拿最長那段補上）
    const candidates = [prefix, ...segments].filter(s => s.length >= 2);
    const main = candidates.reduce((a, b) => (b.length > a.length ? b : a), '');
    const finalSegs = segments.map(s => (s.length >= 2 ? s : main));

    const replies = [];
    for (let i = 0; i < positions.length; i++) {
      const r = await processProxyOrder(env, task, positions[i].zone, finalSegs[i] || main || text);
      replies.push(r);
    }
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
      type: 'text', text: replies.join('\n'),
    }]);
    return;
  }
  if (proxy) {
    userId = proxy.userId;
    text = proxy.text;
    // 若剩下的文字還帶有人名前綴（例「衛生局 倖妤 +1」→ 剝 zone 後 = 「倖妤 +1」），再剝掉人名
    text = await stripLeadingPersonName(env, text);
  } else {
    // 沒比對到區 → 再試人名（real_name / line_display）前綴；有比對到就換成那個人
    const person = await tryProxyPerson(env, userId, text);
    if (person) {
      userId = person.userId;
      text = person.text;
    }
  }

  // 若此人在此任務有待確認的 pending_dup，且這次訊息能辨識成「加/改」→ 直接處理
  const pending = await env.DB.prepare(
    `SELECT new_text, new_data, new_note, new_price FROM pending_dups WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  if (pending) {
    const v = normalizeVerdict(text);
    if (v === '加' || v === '改') {
      await applyDupDecision(env, task.id, userId, pending, v === '加', replyToken);
      return;
    }
  }

  let existing = await env.DB.prepare(
    `SELECT data_json, note, price FROM entries WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  // 請假紀錄（空 data + note=請假）視同空白，該人重新點 → 直接當首次寫入，不問改/加
  if (existing && existing.note === '請假' && (!existing.data_json || existing.data_json === '{}')) {
    await env.DB.prepare(`DELETE FROM entries WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
    existing = null;
  }
  const known = existing ? {
    ...JSON.parse(existing.data_json || '{}'),
    ...(existing.note ? { 備註: existing.note } : {}),
    ...(existing.price ? { 價格: existing.price } : {}),
  } : {};

  // 純確認詞（對/沒錯/OK/嗯/好）：若已有紀錄 → 直接靜默帶過（原記錄保留）
  if (existing && /^[\s]*(對|對阿|對啊|沒錯|是|是的|好|好的|OK|ok|嗯|Y|y)[\s!?！？。.~～]*$/.test(text)) {
    return;
  }
  // 純否認詞（不對/錯了）：計次，第 1 次引導重說，第 2 次以上 @ 管理員裁示
  if (existing && /^[\s]*(不對|錯了|不是|錯|不對啦)[\s!?！？。.~～]*$/.test(text)) {
    const row = await env.DB.prepare(
      `SELECT count FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`
    ).bind(task.id, userId).first();
    const cnt = (row?.count || 0) + 1;
    await env.DB.prepare(
      `INSERT INTO nonsense_strikes (task_id, user_id, count, last_text, last_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(task_id, user_id) DO UPDATE SET count = excluded.count, last_text = excluded.last_text, last_at = datetime('now')`
    ).bind(task.id, userId, cnt, text).run();

    const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
    const who = m?.real_name || m?.line_display || userId.slice(0, 6);
    const oldItem = Object.values(JSON.parse(existing.data_json || '{}')).filter(Boolean).join('/') || '(未辨識)';

    if (cnt >= 2) {
      const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
      const adminNames = [];
      for (const aid of adminIds) {
        const a = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(aid).first();
        const nm = a?.real_name || a?.line_display;
        if (nm) adminNames.push(nm);
      }
      const adminTag = adminNames.length ? adminNames.map(n => `@${n}`).join(' ') + ' ' : '';
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
        type: 'text',
        text: `${adminTag}${who} 已經反應兩次「不對」了，目前紀錄是「${oldItem}」，麻煩您協助問一下實際要點什麼，謝謝 🙏`,
      }]);
    } else {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `${who} 麻煩您再說清楚一點，謝謝您 🙏` }]);
    }
    return;
  }

  // 管理員裁示指令：放行/通過/清除 <姓名>
  if (await tryClearPendingProfanity(env, task, userId, text, replyToken)) return;

  // 明顯非任務相關的閒聊 → 直接靜默（不進 profanity 計數、不進 Gemini）
  if (isChitchat(text)) return;

  // 硬規則：明顯污穢/體液/性暗示字眼直接 @ 管理員，不進 Gemini
  if (isProfane(text)) {
    await handleProfanity(env, task, userId, text, replyToken);
    return;
  }
  // pendingP 僅對「新一次也是污穢」才重複提醒；一般訊息放行（避免無辜訊息被累計）

  // 硬規則：「不要X」/「我不要X」→ 從既有紀錄移除 X（單項則整筆刪）
  // 本人直講或管理員代點（經 tryProxyPerson 已把 userId/text 切好）都適用
  {
    const dropMatch = text.trim().match(/^(?:我)?\s*不要\s*(.+?)\s*(?:啦|了|喔|耶|欸|ㄟ|哦|啊)?[\s!?！？。.~～]*$/);
    if (dropMatch && existing) {
      const rawTarget = (dropMatch[1] || '').trim();
      // 排除「不要了 / 不要」這種全取消詞（讓它走 Gemini cancel 流程，保留原確認邏輯）
      if (rawTarget && !/^(了|的)$/.test(rawTarget)) {
        const existingData = JSON.parse(existing.data_json || '{}');
        const itemStr = existingData['品項'] || '';
        const items = itemStr.split(/\s*\+\s*/).filter(Boolean);
        const norm = (s) => String(s).replace(/\s+/g, '').replace(/[的那個個份]+$/, '').toLowerCase();
        const t = norm(rawTarget);
        const matches = (it) => {
          const n = norm(it);
          if (!t || !n) return false;
          return n.includes(t) || t.includes(n);
        };
        const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
        const who = m?.real_name || m?.line_display || userId.slice(0, 6);
        if (items.length > 1) {
          const remaining = items.filter(it => !matches(it));
          if (remaining.length && remaining.length < items.length) {
            const cancelled = items.filter(it => !remaining.includes(it));
            const newData = { ...existingData, '品項': remaining.join(' + ') };
            if (remaining.length === 1) {
              if (/葷食/.test(remaining[0])) newData['葷素'] = '葷';
              else if (/素食/.test(remaining[0])) newData['葷素'] = '素';
            }
            await env.DB.prepare(
              `UPDATE entries SET data_json = ?, price = NULL, updated_at = datetime('now') WHERE task_id = ? AND user_id = ?`
            ).bind(JSON.stringify(newData), task.id, userId).run();
            await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
              type: 'text', text: `✅ 已幫 ${who} 取消「${cancelled.join('、')}」，剩下「${remaining.join(' + ')}」`,
            }]);
            return;
          }
        } else if (items.length === 1 && matches(items[0])) {
          await env.DB.prepare(`DELETE FROM entries WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
          await env.DB.prepare(`DELETE FROM pending_dups WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
          await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
            type: 'text', text: `✅ 已幫 ${who} 取消「${items[0]}」`,
          }]);
          return;
        }
        // 目標不是現有品項 → 視為特殊需求（如「不要茄子」「不要香菜」），併入 note
        if (items.length >= 1) {
          const noteText = `不要${rawTarget}`;
          const prevNote = String(existing.note || '').trim();
          const parts = prevNote ? prevNote.split(/[;；,，、\s]+/).filter(Boolean) : [];
          if (!parts.some(p => p === noteText || p.includes(noteText))) parts.push(noteText);
          const newNote = parts.join('；');
          await env.DB.prepare(
            `UPDATE entries SET note = ?, updated_at = datetime('now') WHERE task_id = ? AND user_id = ?`
          ).bind(newNote, task.id, userId).run();
          await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
            type: 'text', text: `✅ 已幫 ${who} 加註「${noteText}」`,
          }]);
          return;
        }
      }
    }
  }

  // 撈「品項不適用欄位」知識庫當 Gemini 提示
  const noFieldsRows = await env.DB.prepare(`SELECT item, field FROM item_no_fields`).all();
  const itemNoFields = {};
  for (const r of (noFieldsRows.results || [])) {
    if (!itemNoFields[r.item]) itemNoFields[r.item] = [];
    itemNoFields[r.item].push(r.field);
  }
  // 菜單模式只在「有菜單照 + mode !== 'free'」兩條件同時成立時生效
  const menuItems = (task.menu_json && task.mode !== 'free') ? JSON.parse(task.menu_json) : null;
  // 飲料類任務：強制要有菜單，沒菜單直接擋
  const isDrinkTask = /飲料|飲品|茶|咖啡|手搖|冷飲|熱飲|奶茶|果汁|冰沙/.test(task.task_name || '');
  if (isDrinkTask && !(Array.isArray(menuItems) && menuItems.length)) {
    if (replyToken) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
        type: 'text',
        text: '🥤 此為飲料類任務，請先上傳菜單照後再點單。\n（管理員可在看板上傳菜單，或直接在 LINE 傳菜單圖給我）',
      }]);
    }
    return;
  }
  let parsed = await geminiExtract(env.GEMINI_API_KEY, task.task_name, text, known, itemNoFields, menuItems);
  if (parsed?._error) {
    console.error('[extract error]', parsed._error, 'text=', text);
    // 不再靜默：若文字看起來像合理品項，走下方 looksLikeItem fallback 仍可寫入
    parsed = null;
  }
  // 只有「AI 標髒話 + 完全沒抽到任何合法欄位」才真的觸發裁示；否則當正常點餐
  if (parsed?.profanity && (!parsed.data || Object.keys(parsed.data).length === 0)) {
    await handleProfanity(env, task, userId, text, replyToken);
    return;
  }
  // 防呆：Gemini 偶爾把 value 回成物件 → 壓成字串，避免顯示 [object Object]
  if (parsed?.data && typeof parsed.data === 'object') {
    for (const k of Object.keys(parsed.data)) {
      const v = parsed.data[k];
      if (v && typeof v === 'object') {
        const flat = Object.values(v).filter(x => x != null && x !== '').map(String).join('/');
        parsed.data[k] = flat || '';
      }
    }
  }
  // 便當類 + 只給葷/素 → 自動補全品項（比照 +1 行為）— 僅無菜單模式
  if (parsed?.data && !(Array.isArray(menuItems) && menuItems.length)) {
    const taskIsBento = /便當|飯|自助餐|餐盒|盒餐|簡餐|套餐|早午餐|午餐|晚餐|午晚餐|主食|主餐|正餐|團膳|商業午餐|輕食|熱食|麵食|麵線|拉麵|烏龍麵|粥品|火鍋|鍋物|韓式|日式|西式|排餐|漢堡|義大利麵|壽司|三明治|咖哩|燴飯|炒飯|滷味|鹽酥/.test(task.task_name || '');
    if (taskIsBento && !parsed.data['品項']) {
      const hs = parsed.data['葷素'];
      if (hs === '葷') parsed.data['品項'] = '葷食便當';
      else if (hs === '素') parsed.data['品項'] = '素食便當';
      else if (/(^|[^一二三四五六七八九十百千])葷(?!素)/.test(text) && !/素/.test(text)) { parsed.data['品項'] = '葷食便當'; parsed.data['葷素'] = '葷'; }
      else if (/素(?!食便當|食)/.test(text) && !/葷/.test(text)) { parsed.data['品項'] = '素食便當'; parsed.data['葷素'] = '素'; }
    }
    // 葷/素便當變體 normalize：「葷」、「葷/葷食便當」、「葷食便當/葷」等→「葷食便當」（素同理）
    if (taskIsBento && parsed.data['品項']) {
      const norm = normalizeBentoItem(parsed.data['品項']);
      if (norm) {
        parsed.data['品項'] = norm;
        // 品項已是完整名稱，葷素欄位多餘，避免 entryBody 展開成「葷食便當 / 葷」
        delete parsed.data['葷素'];
      }
    }
  }
  if (parsed?.nonsense) {
    await handleNonsense(env, task, userId, text, replyToken, parsed.follow_up, !!existing);
    return;
  }
  // 取消訂單（全部或指定某項）
  if (parsed?.cancel && existing) {
    const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
    const who = m?.real_name || m?.line_display || userId.slice(0, 6);
    const existingData = JSON.parse(existing.data_json || '{}');
    const itemStr = existingData['品項'] || '';
    const items = itemStr.split(/\s*\+\s*/).filter(Boolean);
    let target = (parsed.cancel_target || '').trim();
    // 若 Gemini 沒給 target，嘗試從訊息裡推斷（針對葷/素關鍵字）
    if (!target && items.length > 1) {
      if (/葷/.test(text) && !/素/.test(text)) target = '葷';
      else if (/素/.test(text) && !/葷/.test(text)) target = '素';
    }

    const norm = (s) => String(s).replace(/\s+/g, '').replace(/[的那個個份]+$/, '').toLowerCase();
    // 指定取消某項 且 有多項 → 只刪該項
    if (target && items.length > 1) {
      const t = norm(target);
      const matches = (it) => {
        const n = norm(it);
        if (!t || !n) return false;
        if (n.includes(t) || t.includes(n)) return true;
        if (t.length <= 2 && n.includes(t)) return true;
        return false;
      };
      const remaining = items.filter(it => !matches(it));
      if (remaining.length && remaining.length < items.length) {
        const cancelled = items.filter(it => !remaining.includes(it));
        const newData = { ...existingData, '品項': remaining.join(' + ') };
        // 若剩單品且 葷素 與剩下品項衝突，修正或清掉
        if (remaining.length === 1) {
          if (/葷食/.test(remaining[0])) newData['葷素'] = '葷';
          else if (/素食/.test(remaining[0])) newData['葷素'] = '素';
        }
        await env.DB.prepare(
          `UPDATE entries SET data_json = ?, price = NULL, updated_at = datetime('now') WHERE task_id = ? AND user_id = ?`
        ).bind(JSON.stringify(newData), task.id, userId).run();
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
          type: 'text', text: `✅ 已幫 ${who} 取消「${cancelled.join('、')}」，剩下「${remaining.join(' + ')}」`,
        }]);
        return;
      }
    }

    // 多項但找不到取消目標 → 請使用者明示，避免誤刪全部
    const tTrim = text.trim();
    const explicitAll = /(都|全部|全|所有|整個|全都|所有的|通通|一起)(不要|取消|刪|不點|不吃|不喝)/.test(text)
      || /^(取消|不要了?|不點了?|不吃了?|不喝了?|都不要了?|我不要了?|我不點了?)[\s!?！？。.~～]*$/.test(tTrim);
    if (items.length > 1 && !explicitAll) {
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
        type: 'text', text: `@${who} 您目前有「${items.join('、')}」，請問是要取消哪一個？要全部取消請說「都不要了」`,
      }]);
      return;
    }

    // 全部取消
    await env.DB.prepare(`DELETE FROM entries WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
    await env.DB.prepare(`DELETE FROM pending_dups WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
    const oldItem = Object.values(existingData).filter(Boolean).join('/') || '(未辨識)';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `✅ 已幫 ${who} 取消「${oldItem}」` }]);
    return;
  }
  if (!parsed || !parsed.data || Object.keys(parsed.data).length === 0) {
    // AI 抽不到但文字看起來像飲料/便當短名詞 → 直接當品項寫入（避免冷僻名稱被拒）
    const tClean = String(text || '').replace(/^(我要|我想要|幫我點|來一?[個份杯碗])/, '').trim();
    const looksLikeItem = tClean.length >= 2 && tClean.length <= 15
      && !/[。?？!！]/.test(tClean)
      && !parsed?.profanity;
    // 菜單模式：很明顯跟餐點無關就不理會（無 follow_up、無食物動詞、沒沾到菜單名稱）
    if (Array.isArray(menuItems) && menuItems.length && !looksLikeItem && !existing) {
      const normText = String(text || '').replace(/\s+/g, '').toLowerCase();
      const hasFoodVerb = /吃|喝|要|點|加|改|換|訂|來|給我|幫/.test(text);
      const touchesMenu = menuItems.some(it => {
        const n = String(it.name || '').replace(/\s+/g, '').toLowerCase();
        return n && (normText.includes(n) || n.includes(normText));
      });
      if (!hasFoodVerb && !touchesMenu) {
        console.log('[off-topic silent]', text);
        return; // 不回覆，讓群組聊天不被 bot 打擾
      }
    }
    // 無菜單模式：嚴格只認便當相關名詞與 +1/加一 等加點意圖；其他閒聊一律沉默
    const hasMenu = Array.isArray(menuItems) && menuItems.length;
    if (!hasMenu && !existing && looksLikeItem) {
      const tNorm = tClean.replace(/\s+/g, '');
      const isBentoTerm = !!normalizeBentoItem(tNorm);
      const isAddOne = /^(\+|＋)\s*1?$/.test(tNorm)
        || /(加|多|再)\s*[一12]/.test(tNorm)
        || /^(加點|加上|加一|再加|再來|多加|多一|多點|多要|多來|累加|追加|外加)/.test(tNorm)
        || /^(可以|能不能|麻煩|請)?(再|多|加)/.test(tNorm);
      if (!isBentoTerm && !isAddOne && !parsed?.follow_up) {
        console.log('[no-menu off-topic silent]', text);
        return;
      }
    }
    if (looksLikeItem) {
      parsed = parsed || {};
      parsed.data = { 品項: tClean };
      // 繼續往下走正常寫入流程（不 return）
    } else {
      if (parsed?.follow_up) {
        const mInfo = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
        const askName = mInfo?.real_name || mInfo?.line_display || userId.slice(0, 6);
        const menuMsgs = await maybeMenuMessages(env, task);
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
          { type: 'text', text: `@${askName} ${parsed.follow_up}` },
          ...menuMsgs,
        ].slice(0, 5));
      }
      return;
    }
  }

  // 菜單模式：品項即一切，不需要葷素欄位（葷素只用在一般便當 +1 無菜單情境）
  if (Array.isArray(menuItems) && menuItems.length && parsed?.data?.品項 && parsed.data['葷素']) {
    delete parsed.data['葷素'];
  }

  // 無菜單便當任務：最終品項只能是「葷食便當」或「素食便當」，其他一律不回應
  // Gemini 偶爾把 key 取成 'item' 而非 '品項'，或把閒聊抽出莫名品項 → 統一在這裡擋
  {
    const hasMenu = Array.isArray(menuItems) && menuItems.length;
    const taskIsBento = /便當|飯|自助餐|餐盒|盒餐|簡餐|套餐|早午餐|午餐|晚餐|午晚餐|主食|主餐|正餐|團膳|商業午餐|輕食|熱食|麵食|麵線|拉麵|烏龍麵|粥品|火鍋|鍋物|韓式|日式|西式|排餐|漢堡|義大利麵|壽司|三明治|咖哩|燴飯|炒飯|滷味|鹽酥/.test(task.task_name || '');
    if (!hasMenu && taskIsBento && parsed?.data) {
      // 把非標品項欄位（如 Gemini 把 key 取成 item）reflow 進「品項」並 normalize
      if (!parsed.data['品項']) {
        for (const k of ['item', 'Item', '名稱', '餐點', 'food', 'name']) {
          if (parsed.data[k]) { parsed.data['品項'] = parsed.data[k]; delete parsed.data[k]; break; }
        }
      }
      const norm = parsed.data['品項'] ? normalizeBentoItem(parsed.data['品項']) : null;
      if (norm) {
        parsed.data['品項'] = norm;
        delete parsed.data['葷素'];
      } else {
        // 不是葷食/素食便當 → silent，不寫入也不回覆
        console.log('[no-menu non-bento silent]', text, '->', parsed.data['品項']);
        return;
      }
    }
  }

  // 菜單模式：非白名單品項需模糊比對；多候選/未命中 → 追問，不寫入
  // 注意：admin 也要受限（admin 裁定應走明確流程，不是自動 bypass）
  if (Array.isArray(menuItems) && menuItems.length && parsed?.data?.品項) {
    const DEFAULT_PASSES = new Set(['葷食便當', '素食便當']);
    let itemName = String(parsed.data.品項).trim();
    // 防止 Gemini 自作主張把「牛排」這種短義詞升級成某個全名（例：菲力牛排）。
    // 若使用者原話是個更短/更模糊的形式、而它在菜單上能對到 2+ 候選 → 以原話走 guard。
    if (!DEFAULT_PASSES.has(itemName)) {
      const rawTrim = String(text || '').trim();
      if (rawTrim && rawTrim !== itemName && rawTrim.length < itemName.length) {
        const rawCands = matchMenuCandidates(menuItems, rawTrim);
        if (rawCands.length >= 2) {
          itemName = rawTrim;
          parsed.data.品項 = rawTrim;
        }
      }
    }
    if (!DEFAULT_PASSES.has(itemName)) {
      const cands = matchMenuCandidates(menuItems, itemName);
      const mInfo = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
      const askName = mInfo?.real_name || mInfo?.line_display || userId.slice(0, 6);
      if (cands.length === 1) {
        // 唯一對應：柔性修正到菜單名稱，直接幫點
        parsed.data.品項 = cands[0].name;
        if (cands[0].price && parsed.price == null) parsed.price = cands[0].price;
      } else {
        // 非點餐關鍵字 → 靜默
        const offTopic = /刪除|刪\b|取消|管理|裁定|謝謝|感恩|辛苦|再見|掰掰|晚安|早安|午安|收到|了解|ok$|好的$|好喔|好啊/i.test(text);
        if (offTopic) {
          console.log('[off-topic silent on menu miss]', text);
          return;
        }
        // 配對不到 / 多候選 → 一律請使用者自己上看板點
        const base = env.PUBLIC_BASE_URL || env.PUBLIC_HOST || 'https://assist-gcl.pages.dev';
        const boardUrl = `${base}/t/${task.url_slug || task.id}`;
        await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [
          { type: 'text', text: `@${askName} 「${itemName}」無法直接對到菜單，請到看板點選：\n${boardUrl}` },
        ]);
        return;
      }
    }
  }

  // 已點過再講話的處理：
  //   1. 完全相同 → 重複確認，不動
  //   2. 明確「加點」字眼（高信心）→ 自動累加
  //   3. 其他（包含 replace 高信心）→ 先反問當事人「是要改還是加？」，避免誤刪舊紀錄
  let additive = false;
  let oldItemForReport = '';
  if (existing) {
    const oldData = JSON.parse(existing.data_json || '{}');
    const sameData = JSON.stringify(oldData) === JSON.stringify(parsed.data || {})
      && (existing.note || null) === (parsed.note || null)
      && (existing.price || null) === (parsed.price ?? null);
    if (sameData) {
      const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
      const who = m?.real_name || m?.line_display || userId.slice(0, 6);
      const parts = Object.values(oldData).filter(Boolean).join('/');
      await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `${who} 您已經點過「${parts}」了，記錄維持原樣～` }]);
      return;
    }
    const intent = parsed.dup_intent;
    const conf = typeof parsed.dup_confidence === 'number' ? parsed.dup_confidence : 0;
    // 訊息含明確改/換字眼 → 直接改（不用兩階段）
    const hasReplaceWord = /(^|[\s，,。、])?(改|換|更改|改成|改為|換成|換為|修改|取代|替換)/.test(text);
    const hasAddWord = /(^|[\s，,。、])(加|加點|加上|再加|再來|多加|多點|還要|外加|追加|併|合併)/.test(text);
    const taskIsBentoLike = /便當|飯|自助餐|餐盒|盒餐|簡餐|套餐|早午餐|午餐|晚餐|午晚餐|主食|主餐|正餐|團膳|商業午餐|輕食|熱食|麵食|麵線|拉麵|烏龍麵|粥品|火鍋|鍋物|韓式|日式|西式|排餐|漢堡|義大利麵|壽司|三明治|咖哩|燴飯|炒飯|滷味|鹽酥/.test(task.task_name || '');
    if (hasReplaceWord && !hasAddWord) {
      additive = false; // 直接改
    } else if (hasAddWord && !hasReplaceWord) {
      additive = true;
    } else if (taskIsBentoLike) {
      // 便當類預設改單（便當很少加點），跳過反問
      additive = false;
    } else if (intent === 'add' && conf >= 80) {
      additive = true;
    } else {
      // 其他一律反問當事人是改還是加，避免把舊的吃掉
      await askAddOrReplace(env, task, userId, text, parsed, oldData, replyToken);
      return;
    }
  }

  await upsertEntry(env.DB, {
    taskId: task.id,
    userId,
    data: parsed.data,
    note: parsed.note,
    price: parsed.price,
    rawText: text,
    additive,
  });
  // 成功收單 → 清零否認/亂點/誤判髒話計數
  await env.DB.prepare(`DELETE FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).run();
  await env.DB.prepare(`DELETE FROM pending_profanity WHERE user_id = ?`).bind(userId).run();
  // 學習：若使用者填了「不適用」欄位，記到 item_no_fields（品項層級，跨任務保留）
  await learnNoFields(env.DB, parsed.data);

  const parts = Object.values(parsed.data).filter(Boolean).join('/');
  const price = parsed.price ? ` $${parsed.price}` : '';
  const note = parsed.note ? `（${parsed.note}）` : '';
  // 過濾 missing：若 data 已含該欄位（或同義詞），就不算缺
  const dataKeys = new Set(Object.keys(parsed.data || {}));
  const synonyms = { '甜度': ['糖度'], '冰塊': ['冰量', '冰度'], '份量': ['大小', '飯量'] };
  const hasField = (k) => dataKeys.has(k) || (synonyms[k] || []).some(s => dataKeys.has(s));
  // 被動欄位黑名單：預設不主動追問（除非 AI 很堅持且 data 已有）
  const PASSIVE_FIELDS = new Set(['份量', '飯量', '大小', '葷素', '辣度', '備註', '忌口']);
  const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
    .filter(k => !hasField(k))
    .filter(k => !PASSIVE_FIELDS.has(k));
  const followUp = missing.length ? (parsed.follow_up || '') : '';

  const m = await env.DB.prepare(
    `SELECT real_name, line_display FROM members WHERE user_id = ?`
  ).bind(userId).first();
  const name = (m?.real_name || m?.line_display || userId.slice(0, 6));

  // 是否明確改/換字眼 → 肯定句收尾
  const isBentoTask = /便當|飯|自助餐|餐盒|盒餐|簡餐|套餐|早午餐|午餐|晚餐|午晚餐|主食|主餐|正餐|團膳|商業午餐|輕食|熱食|麵食|麵線|拉麵|烏龍麵|粥品|火鍋|鍋物|韓式|日式|西式|排餐|漢堡|義大利麵|壽司|三明治|咖哩|燴飯|炒飯|滷味|鹽酥/.test(task.task_name || '');
  const explicitReplace = /(^|[\s，,。、])?(改|換|更改|改成|改為|換成|換為|修改|取代|替換)/.test(text) || (isBentoTask && existing && !additive);
  const explicitAdd = /(^|[\s，,。、])?(加|加點|加上|再加|再來|多加|多點|還要|外加|追加)/.test(text);
  // 品項能代表葷素時，就省略「葷素」欄位避免重複
  // 菜單模式下，若品項是菜單料理（非預設葷/素食便當），也省略葷素以免出現「葷/牛小排」
  const dataForShow = { ...parsed.data };
  if (dataForShow['品項']) {
    if (/葷食|素食/.test(dataForShow['品項'])) {
      delete dataForShow['葷素'];
    } else if (Array.isArray(menuItems) && menuItems.length) {
      delete dataForShow['葷素'];
    }
  }
  const showParts = Object.values(dataForShow).filter(Boolean).join('/');
  let reply;
  if (existing && additive && explicitAdd) {
    reply = `✅ 已幫 ${name} 加點 ${showParts}${price}${note}`;
  } else if (existing && additive) {
    reply = `${name} 加點 ${showParts}${price}${note}，是這樣嗎？`;
  } else if (existing && !additive && explicitReplace) {
    reply = `✅ 已幫 ${name} 換成 ${showParts}${price}${note}`;
  } else if (existing && !additive) {
    const tail = oldItemForReport ? `（原「${oldItemForReport}」已取消）` : '';
    reply = `${name} 改為 ${parts}${price}${note}${tail}，是這樣嗎？`;
  } else {
    reply = `${name} ${parts}${price}${note}`;
  }
  if (missing.length && followUp) {
    reply += `\n@${name} ${followUp}`;
  }
  // 同群組其他開啟中任務：若該人在其他任務仍掛請假 → 不合理，清掉並提醒要什麼
  const pendingMenuMsgs = [];
  if (groupId) {
    const siblings = await env.DB.prepare(
      `SELECT id, task_name, menu_json, mode FROM tasks WHERE group_id = ? AND status = 'open' AND id != ?`
    ).bind(groupId, task.id).all();
    const leaveTasks = [];
    const blankTasks = [];
    const pendingSibs = [];
    for (const sib of (siblings.results || [])) {
      const row = await env.DB.prepare(
        `SELECT data_json, note FROM entries WHERE task_id = ? AND user_id = ?`
      ).bind(sib.id, userId).first();
      if (!row) { blankTasks.push(sib.task_name); pendingSibs.push(sib); continue; }
      const isLeave = row.note === '請假' && (!row.data_json || row.data_json === '{}');
      if (isLeave) {
        await env.DB.prepare(`DELETE FROM entries WHERE task_id = ? AND user_id = ?`).bind(sib.id, userId).run();
        leaveTasks.push(sib.task_name);
        pendingSibs.push(sib);
      } else if (!row.data_json || row.data_json === '{}') {
        blankTasks.push(sib.task_name);
        pendingSibs.push(sib);
      }
    }
    const pending = [...leaveTasks, ...blankTasks];
    if (pending.length) {
      const hint = leaveTasks.length
        ? `（${leaveTasks.join('、')}原本請假不合理，已清掉）`
        : '';
      reply += `\n@${name} 另外「${pending.join('、')}」要什麼呢？${hint}`;
      // 附帶 PO 尚未點的任務的菜單照（若有 + 1 分鐘冷卻未到期會自動跳過）
      for (const sib of pendingSibs) {
        if (pendingMenuMsgs.length >= 4) break;
        const msgs = await maybeMenuMessages(env, sib);
        for (const m of msgs) {
          if (pendingMenuMsgs.length >= 4) break;
          pendingMenuMsgs.push(m);
        }
      }
    }
  }
  const outMsgs = [{ type: 'text', text: reply }, ...pendingMenuMsgs].slice(0, 5);
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, outMsgs);
}

// 學習「品項沒有這個欄位」的規則，跨任務持久保留
async function learnNoFields(DB, data) {
  if (!data || typeof data !== 'object') return;
  const item = data['品項'];
  if (!item) return;
  for (const [k, v] of Object.entries(data)) {
    if (k === '品項') continue;
    if (typeof v === 'string' && /^(不適用|無|沒有|N\/A|無此選項)$/i.test(v.trim())) {
      try {
        await DB.prepare(`INSERT OR IGNORE INTO item_no_fields (item, field) VALUES (?, ?)`).bind(item, k).run();
      } catch (e) { console.error('[learnNoFields]', e); }
    }
  }
}

function genDownloadToken() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// 把 entries 正規化成 {name, item, data(其他欄位), note, price} 陣列
// Gemini 偶爾把 key 取成 item / Item / 名稱 / 餐點 / food / name 而不是「品項」
// → 這裡按優先順序 fallback，並從 rest 一併剝除這些 key，避免 XLSX 多冒一欄重複的 item
const ITEM_KEYS = ['品項', 'item', 'Item', '名稱', '餐點', 'food', 'name'];
export function normalizeParsed(entries) {
  return entries.map(e => {
    let data = {};
    try { data = JSON.parse(e.data_json || '{}'); } catch {}
    const rawName = e.real_name || e.line_display || (e.user_id ? e.user_id.slice(0, 6) : '');
    // 看板下單會加 🌐 前綴做來源識別；XLSX 給店家看不需要這個符號
    const name = String(rawName).replace(/^🌐\s*/, '');
    let item = '';
    for (const k of ITEM_KEYS) { if (data[k]) { item = String(data[k]); break; } }
    // 葷/素變體 → 統一便當名稱（修舊資料的「葷食便當/葷」這種重複展開）
    const norm = normalizeBentoItem(item);
    if (norm) item = norm;
    const rest = { ...data };
    for (const k of ITEM_KEYS) delete rest[k];
    // item 已 normalize 成「葷食便當」/「素食便當」時，再把多餘的「葷素」清掉
    if (norm) delete rest['葷素'];
    return { name, item, data, rest, note: e.note || '', price: e.price, updated: e.updated_at, zone: e.zone || '' };
  });
}

// 產生多段 XLSX rows：① 訂購彙總 ② 明細 ③ 請假名單（如有）
// 請假/不吃 不計入「總筆數」「訂購彙總」「明細」，獨立列在第三段表格
// opts.mode = 'free' → 拿掉小計／金額欄（無菜單便當沒價格）
// opts.zoneOrder = { '衛生局': 0, '楠西區': 1, ... } → 自訂 zone 排序權重
export function buildSheetRows(taskName, entries, opts = {}) {
  const noPrice = opts.mode === 'free';
  const zoneOrder = opts.zoneOrder || {};
  const IN_OFFICE = new Set(['楠西區', '南化區', '左鎮區', '新市區']);
  const zoneTier = (z) => z === '衛生局' ? 0 : (IN_OFFICE.has(z) ? 1 : 2);
  const zoneSort = (z) => zoneOrder[z] != null ? zoneOrder[z] : 9999;
  const all = normalizeParsed(entries);
  const isLeave = (p) => p.note === '請假' || p.note === '不吃';
  const parsed = all.filter(p => !isLeave(p));
  const leaves = all.filter(p => isLeave(p));

  // 彙總：品項 → 份數、備註(含人名)、小計
  const groups = {};
  parsed.forEach(p => {
    const key = p.item || '(未辨識)';
    if (!groups[key]) groups[key] = { count: 0, notes: [], total: 0, people: [] };
    const g = groups[key];
    g.count += 1;
    g.total += p.price || 0;
    g.people.push(p.name);
    // 把備註與「非品項」欄位一起當修飾（方便店家看）
    //  - 跳過 '姓名'：看板下單會把會員名寫進 data['姓名']，這跟 p.name 完全重複
    const modParts = [];
    for (const k of Object.keys(p.rest)) {
      if (k === '姓名') continue;
      if (p.rest[k]) modParts.push(`${k}:${p.rest[k]}`);
    }
    if (p.note) modParts.push(p.note);
    if (modParts.length) g.notes.push(`${p.name}（${modParts.join('、')}）`);
  });

  const rows = [];
  rows.push([`任務：${taskName}　訂購：${parsed.length}　請假：${leaves.length}`]);
  rows.push([]);

  // ① 訂購彙總
  rows.push(['■ 訂購彙總（對店家）']);
  rows.push(noPrice
    ? ['品項', '份數', '備註 / 特殊要求']
    : ['品項', '份數', '備註 / 特殊要求', '小計']);
  let grandCount = 0, grandTotal = 0;
  Object.keys(groups)
    .sort((a, b) => groups[b].count - groups[a].count || a.localeCompare(b, 'zh-Hant'))
    .forEach(k => {
      const g = groups[k];
      rows.push(noPrice
        ? [k, String(g.count), g.notes.join('；')]
        : [k, String(g.count), g.notes.join('；'), g.total ? String(g.total) : '']);
      grandCount += g.count;
      grandTotal += g.total;
    });
  rows.push(noPrice
    ? ['合計', String(grandCount), '']
    : ['合計', String(grandCount), '', grandTotal ? String(grandTotal) : '']);
  rows.push([]);

  // ② 明細：依品項排序（相同品項排一起），方便發餐
  //  - 姓名已有獨立欄位 → 排除 rest 裡同名的 '姓名'（避免整欄重複）
  //  - 分組資訊對店家發餐無用 → 不列入，順便讓上下欄數對齊（品項/姓名/備註/金額）
  const restFields = [];
  parsed.forEach(p => {
    for (const k of Object.keys(p.rest)) {
      if (k === '姓名') continue;
      if (!restFields.includes(k)) restFields.push(k);
    }
  });
  rows.push(['■ 明細（依品項排序，發餐用）']);
  rows.push(noPrice
    ? ['品項', '區', '姓名', ...restFields, '備註']
    : ['品項', '區', '姓名', ...restFields, '備註', '金額']);
  // 同品項內排序：衛生局 → 在局 4 區 → 一般衛生所（依 sort_order）→ 同 tier 依姓名
  const sorted = [...parsed].sort((a, b) => {
    const ai = a.item || '~'; const bi = b.item || '~';
    if (ai !== bi) return ai.localeCompare(bi, 'zh-Hant');
    const at = zoneTier(a.zone || ''), bt = zoneTier(b.zone || '');
    if (at !== bt) return at - bt;
    const ao = zoneSort(a.zone || ''), bo = zoneSort(b.zone || '');
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name, 'zh-Hant');
  });
  sorted.forEach(p => {
    const baseRow = [
      p.item || '(未辨識)',
      p.zone || '',
      p.name,
      ...restFields.map(k => p.rest[k] == null ? '' : String(p.rest[k])),
      p.note || '',
    ];
    if (!noPrice) baseRow.push(p.price != null ? String(p.price) : '');
    rows.push(baseRow);
  });

  // ③ 請假名單（不計入訂購）
  if (leaves.length) {
    rows.push([]);
    rows.push([`■ 請假名單（${leaves.length} 人，不計入訂購）`]);
    rows.push(['姓名', '區', '備註', '時間']);
    const sortedLeaves = [...leaves].sort((a, b) => (a.zone || '~').localeCompare(b.zone || '~', 'zh-Hant') || a.name.localeCompare(b.name, 'zh-Hant'));
    sortedLeaves.forEach(p => {
      rows.push([p.name, p.zone || '', p.note || '請假', String(p.updated || '').slice(0, 16)]);
    });
  }

  return rows;
}

// 產生對店家的彙總文字（給 LINE 群組訊息）
// 請假/不吃 不計入訂購（獨立列「請假 N 人」資訊）
function buildAggregateText(taskName, entries) {
  const all = normalizeParsed(entries);
  const isLeave = (p) => p.note === '請假' || p.note === '不吃';
  const parsed = all.filter(p => !isLeave(p));
  const leaveCount = all.length - parsed.length;
  const groups = {};
  parsed.forEach(p => {
    const key = p.item || '(未辨識)';
    if (!groups[key]) groups[key] = { count: 0, total: 0 };
    groups[key].count += 1;
    groups[key].total += p.price || 0;
  });
  const lines = Object.keys(groups)
    .sort((a, b) => groups[b].count - groups[a].count || a.localeCompare(b, 'zh-Hant'))
    .map(k => {
      const g = groups[k];
      const price = g.total ? ` ＄${g.total}` : '';
      return `・${k} x${g.count}${price}`;
    });
  const totalCount = parsed.length;
  const totalPrice = parsed.reduce((s, p) => s + (p.price || 0), 0);
  const leaveTail = leaveCount ? `　（請假 ${leaveCount} 人，不計入）` : '';
  const totalLine = `合計：${totalCount} 份${totalPrice ? `　＄${totalPrice}` : ''}${leaveTail}`;
  return `📦「${taskName}」訂購彙總（對店家）\n${lines.join('\n')}\n\n${totalLine}`;
}

// 葷/素便當變體 → 統一為「葷食便當」/「素食便當」
// 例：「葷」「葷食」「葷食便當」「葷/葷食便當」「葷食便當/葷」「葷／葷食」皆 → 葷食便當
function normalizeBentoItem(item) {
  if (!item) return null;
  const parts = String(item).split(/\s*[\/／、,，+＋]\s*/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const isMeat = (s) => /^(葷|葷食|葷食便當)$/.test(s);
  const isVeg = (s) => /^(素|素食|素食便當)$/.test(s);
  if (parts.every(isMeat)) return '葷食便當';
  if (parts.every(isVeg)) return '素食便當';
  return null;
}

function normalizeVerdict(s) {
  const t = String(s).trim().toUpperCase().replace(/[\s!?！？。.]+/g, '');
  // 加點／累加（中文詞、英文詞含常見打錯字、符號）
  if (/^(\+|＋|加|加點|加上|加一|再加|再來|多加|多一|多點|多要|多來|累加|追加|一起|都要|還要|還需要|外加|併|合併|和|與)/.test(t)) return '加';
  if (/(再一(份|杯|個|碗|份兒))/.test(t)) return '加';
  if (/(多(一|兩|三)?(份|杯|個|碗))/.test(t)) return '加';
  // 英文：ADD / PLUS / AND / EXTRA / MORE / APPEND / ACCUM（含常見打錯字，只比對前幾碼）
  if (/^(AD+|PLU?S+|ANDD?|EXT|MOR|APP|ACCU?|APND|INCR)/.test(t)) return '加';
  // 改單／覆蓋
  if (/^(改|更改|改成|改為|改了|修改|換|換成|換為|重新|重點|取代|替換|覆蓋|不要剛剛|不要上面|以新|新的|以新為主)/.test(t)) return '改';
  if (/(取消前面|取消上面|取消剛剛|取消之前)/.test(t)) return '改';
  // 英文：REPLACE / CHANGE / MODIFY / EDIT / OVERWRITE / UPDATE（打錯字容錯）
  if (/^(REPL?|CHAN?G?|CHN?G?|MODI?|EDI?T?|OVER?W?|UPDT?|UPD|RWRT|CORR?)/.test(t)) return '改';
  if (/^(收|OK|可以|好|照記|照寫|記下|記|收下|就這樣|照舊)/.test(t)) return '收';
  if (/^(問|再問|重問|再一次|重來|AGAIN|RETRY|問他|問一下|叫他|叫他講|請他)/.test(t)) return '問';
  if (/^(略|略過|跳過|跳|忽略|算了|不要|不用管|不管|別管|別理|不理)/.test(t)) return '略';
  if (/(不吃|沒吃|不來|別吃|他不|不點|不用了|不用吃)/.test(t)) return '略';
  return null;
}

async function handleVerdict(env, groupId, nameHint, action, replyToken) {
  // 先找 pending_dups（加/改 場景）
  if (action === '加' || action === '改') {
    const dups = await env.DB.prepare(
      `SELECT p.task_id, p.user_id, p.new_text, p.new_data, p.new_note, p.new_price,
              m.real_name, m.line_display
         FROM pending_dups p
         JOIN tasks t ON t.id = p.task_id
         LEFT JOIN members m ON m.user_id = p.user_id
        WHERE t.group_id = ? AND t.status = 'open'
        ORDER BY p.created_at DESC`
    ).bind(groupId).all();
    const dlist = dups.results || [];
    const dhit = dlist.find(r => {
      const n = r.real_name || r.line_display || '';
      return n.startsWith(nameHint) || n.includes(nameHint);
    });
    if (dhit) {
      await applyDupDecision(env, dhit.task_id, dhit.user_id, {
        new_text: dhit.new_text, new_data: dhit.new_data, new_note: dhit.new_note, new_price: dhit.new_price,
      }, action === '加', replyToken);
      return;
    }
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `找不到待裁定的「${nameHint}」` }]);
    return;
  }

  // 找該群組目前有 pending nonsense 的使用者（以名字/暱稱前綴比對）
  const pending = await env.DB.prepare(
    `SELECT n.task_id, n.user_id, n.last_text, m.real_name, m.line_display, t.task_name
       FROM nonsense_strikes n
       JOIN tasks t ON t.id = n.task_id
       LEFT JOIN members m ON m.user_id = n.user_id
      WHERE t.group_id = ? AND t.status = 'open' AND n.count >= 2
      ORDER BY n.last_at DESC`
  ).bind(groupId).all();
  const list = pending.results || [];
  const hit = list.find(r => {
    const n = r.real_name || r.line_display || '';
    return n.startsWith(nameHint) || n.includes(nameHint);
  });
  if (!hit) {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `找不到待裁定的「${nameHint}」` }]);
    return;
  }
  const who = hit.real_name || hit.line_display || hit.user_id.slice(0, 6);

  if (action === '收') {
    // 照字面收：把 last_text 當一次正常的 extract 輸入，強制記下
    const known = {}; // 忽略 known，直接以這次文字為主
    const parsed = await geminiExtract(env.GEMINI_API_KEY, hit.task_name, hit.last_text, known);
    const data = (parsed && parsed.data && Object.keys(parsed.data).length) ? parsed.data : { 品項: hit.last_text };
    await upsertEntry(env.DB, {
      taskId: hit.task_id, userId: hit.user_id,
      data, note: (parsed?.note || null), price: (parsed?.price || null), rawText: hit.last_text,
    });
    await env.DB.prepare(`DELETE FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`).bind(hit.task_id, hit.user_id).run();
    const parts = Object.values(data).filter(Boolean).join('/');
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `✓ ${who} ${parts}（管理員裁定收下）` }]);
    return;
  }
  if (action === '問') {
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `${who}，認真講一下要什麼～` }]);
    // 不清除 strikes，等他重答
    return;
  }
  if (action === '略') {
    // 記為「不吃」
    await upsertEntry(env.DB, {
      taskId: hit.task_id, userId: hit.user_id,
      data: {}, note: '不吃', price: null, rawText: hit.last_text,
    });
    await env.DB.prepare(`DELETE FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`).bind(hit.task_id, hit.user_id).run();
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `✓ ${who}：不吃（管理員裁定略過）` }]);
    return;
  }
}

async function applyDupDecision(env, taskId, userId, pending, additive, replyToken) {
  // 改單先記舊品項（用於回報「原 X 取消」）
  let oldItem = '';
  if (!additive) {
    const oldRow = await env.DB.prepare(`SELECT data_json FROM entries WHERE task_id = ? AND user_id = ?`).bind(taskId, userId).first();
    oldItem = oldRow ? (Object.values(JSON.parse(oldRow.data_json || '{}')).filter(Boolean).join('/') || '') : '';
  }
  const data = JSON.parse(pending.new_data || '{}');
  await upsertEntry(env.DB, {
    taskId, userId,
    data,
    note: pending.new_note,
    price: pending.new_price,
    rawText: pending.new_text,
    additive,
  });
  await learnNoFields(env.DB, data);
  await env.DB.prepare(`DELETE FROM pending_dups WHERE task_id = ? AND user_id = ?`).bind(taskId, userId).run();
  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const row = await env.DB.prepare(`SELECT data_json, note, price FROM entries WHERE task_id = ? AND user_id = ?`).bind(taskId, userId).first();
  const finalData = JSON.parse(row?.data_json || '{}');
  const parts = Object.values(finalData).filter(Boolean).join('/');
  const price = row?.price ? ` $${row.price}` : '';
  const verb = additive ? '加點' : '改為';
  const tail = (!additive && oldItem) ? `（原「${oldItem}」已取消）` : '';

  // 檢查還缺什麼欄位（重新跑 AI 用最終資料當 known）
  const task = await env.DB.prepare(`SELECT task_name FROM tasks WHERE id = ?`).bind(taskId).first();
  let followUp = '';
  if (task?.task_name) {
    const known = { ...finalData, ...(row.note ? { 備註: row.note } : {}), ...(row.price ? { 價格: row.price } : {}) };
    const noFieldsRows = await env.DB.prepare(`SELECT item, field FROM item_no_fields`).all();
    const itemNoFields = {};
    for (const r of (noFieldsRows.results || [])) {
      if (!itemNoFields[r.item]) itemNoFields[r.item] = [];
      itemNoFields[r.item].push(r.field);
    }
    const check = await geminiExtract(env.GEMINI_API_KEY, task.task_name, pending.new_text || '', known, itemNoFields);
    const syn = { '甜度': ['糖度'], '冰塊': ['冰量', '冰度'], '份量': ['大小', '飯量'] };
    const finalKeys = new Set(Object.keys(finalData));
    const stillMissing = (Array.isArray(check?.missing) ? check.missing : [])
      .filter(k => !(finalKeys.has(k) || (syn[k] || []).some(s => finalKeys.has(s))));
    if (stillMissing.length) {
      const fu = check?.follow_up || `請問${stillMissing.join('、')}要什麼呢？`;
      followUp = `\n不過還差一點資訊～${fu}`;
    }
  }
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: `✓ ${who} ${verb} ${parts}${price}${tail}${followUp}` }]);
}

// 反問當事人：要改還是再加一份
async function askAddOrReplace(env, task, userId, text, parsed, oldData, replyToken) {
  await env.DB.prepare(
    `INSERT INTO pending_dups (task_id, user_id, new_text, new_data, new_note, new_price, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       new_text = excluded.new_text, new_data = excluded.new_data,
       new_note = excluded.new_note, new_price = excluded.new_price,
       created_at = datetime('now')`
  ).bind(task.id, userId, text, JSON.stringify(parsed.data || {}), parsed.note || null, parsed.price ?? null).run();
  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const oldParts = Object.values(oldData).filter(Boolean).join('/');
  const newParts = Object.values(parsed.data || {}).filter(Boolean).join('/') || text;
  // 若 AI 有偵測到 missing 欄位，附上追問
  const dataKeys = new Set(Object.keys(parsed.data || {}));
  const syn = { '甜度': ['糖度'], '冰塊': ['冰量', '冰度'], '份量': ['大小', '飯量'] };
  const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
    .filter(k => !(dataKeys.has(k) || (syn[k] || []).some(s => dataKeys.has(s))));
  const followUp = (missing.length && parsed.follow_up) ? `\n另外，${parsed.follow_up}` : '';
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
    type: 'text',
    text: `${who} 您已經點了「${oldParts}」，剛剛的「${newParts}」，請問是要「更改」還是「加點」呢？\n請回覆，謝謝您 🙏${followUp}`,
  }]);
}

// 60~80%：反問當事人本人是否為 XXX（改單 / 加點）
async function askSelfConfirm(env, task, userId, text, parsed, intent, replyToken) {
  // 用 pending_dups 暫存本次解析結果，等他確認
  await env.DB.prepare(
    `INSERT INTO pending_dups (task_id, user_id, new_text, new_data, new_note, new_price, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       new_text = excluded.new_text, new_data = excluded.new_data,
       new_note = excluded.new_note, new_price = excluded.new_price,
       created_at = datetime('now')`
  ).bind(task.id, userId, text, JSON.stringify(parsed.data || {}), parsed.note || null, parsed.price ?? null).run();
  const parts = Object.values(parsed.data || {}).filter(Boolean).join('/') || text;
  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const verb = intent === 'add' ? '加點' : '改單';
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
    type: 'text',
    text: `${who} 想跟您確認一下，請問是要${verb}「${parts}」嗎？\n回「加」=加點、「改」=改單，謝謝您 🙏`,
  }]);
}

// <60%：問管理員裁定 加/改
async function handleDupPending(env, task, userId, text, parsed, replyToken) {
  await env.DB.prepare(
    `INSERT INTO pending_dups (task_id, user_id, new_text, new_data, new_note, new_price, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       new_text = excluded.new_text, new_data = excluded.new_data,
       new_note = excluded.new_note, new_price = excluded.new_price,
       created_at = datetime('now')`
  ).bind(task.id, userId, text, JSON.stringify(parsed.data || {}), parsed.note || null, parsed.price ?? null).run();

  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const oldRow = await env.DB.prepare(`SELECT data_json FROM entries WHERE task_id = ? AND user_id = ?`).bind(task.id, userId).first();
  const oldItem = oldRow ? (JSON.parse(oldRow.data_json || '{}')['品項'] || '') : '';
  const newItem = Object.values(parsed.data || {}).filter(Boolean).join('/') || text;

  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const adminNames = [];
  for (const aid of adminIds) {
    const a = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(aid).first();
    const nm = a?.real_name || a?.line_display;
    if (nm) adminNames.push(nm);
  }
  const adminTag = adminNames.length ? adminNames.map(n => `@${n}`).join(' ') + ' ' : '';
  const reply = `${adminTag}打擾一下～${who} 原本點的是「${oldItem}」，剛剛又提到「${newItem}」，麻煩您裁示一下是要「加點」還是「改單」呢？謝謝 🙏`;
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

// 管理員標「請假」：偵測「新化請假」「北區不吃」「南區跳過」等
// 回傳 { userId: 'zone:<名>', zoneName } 或 null
async function tryZoneLeave(env, userId, text) {
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.includes(userId)) return null;

  const t = String(text || '').trim();
  const m = t.match(/^(.{1,8}?)(?:\s*)(請假|休假|不吃|沒訂|跳過|不訂|沒點)$/);
  if (!m) return null;

  const zoneHint = m[1].replace(/區$/, '');
  // 從 zones 表找：完全相符 或 含此關鍵字
  const zonesRow = await env.DB.prepare(
    `SELECT name FROM zones WHERE enabled = 1 ORDER BY length(name) DESC`
  ).all();
  const allZones = (zonesRow.results || []).map(r => r.name);
  let zoneName = allZones.find(n => n === m[1]) || allZones.find(n => n === m[1] + '區');
  if (!zoneName) zoneName = allZones.find(n => n.startsWith(zoneHint) || n.includes(zoneHint));
  if (!zoneName) return null;

  const synthId = `zone:${zoneName}`;
  await env.DB.prepare(
    `INSERT INTO members (user_id, real_name, zone, bound_at, last_seen_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET zone = excluded.zone, last_seen_at = datetime('now')`
  ).bind(synthId, zoneName, zoneName).run();
  return { userId: synthId, zoneName };
}

// 管理員代點：偵測「幫南區點素食便當」「衛生局要一個排骨飯」等
// 回傳 {userId, text} 或 null。userId 會被替換為 zone:<名稱>，text 則是移除代點用詞的點餐內容
// 僅剝掉文字最前面的人名前綴（不改變 userId）；給 zone 代點後的剩餘文本用
async function stripLeadingPersonName(env, text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 3) return trimmed;
  const rows = await env.DB.prepare(
    `SELECT real_name, line_display FROM members WHERE user_id NOT LIKE 'zone:%'`
  ).all();
  const normName = (s) => String(s || '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, '')
    .replace(/[\s·・\.、,，!！?？]+/g, '')
    .trim();
  const names = new Set();
  for (const r of (rows.results || [])) {
    const rn = normName(r.real_name); const ld = normName(r.line_display);
    if (rn && rn.length >= 2) names.add(rn);
    if (ld && ld.length >= 2) names.add(ld);
  }
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const nm of sorted) {
    const re = new RegExp('^[\\s\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\uFE0F\\u200D]*' +
      nm.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\uFE0F\\u200D]*') +
      '[\\s:：,，、]*(.*)$', 'u');
    const m = trimmed.match(re);
    if (m) return (m[1] || '').trim() || trimmed;
  }
  return trimmed;
}

// 偵測人名前綴（admin 代點用），例：「倖妤 葷食便當」「倖妤+1」→ 改用該人的 user_id
async function tryProxyPerson(env, userId, text) {
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.includes(userId)) return null;
  const trimmed = String(text || '').trim();
  if (trimmed.length < 3) return null;
  // 取候選人名（排除 synthetic zone:）
  const rows = await env.DB.prepare(
    `SELECT user_id, real_name, line_display FROM members WHERE user_id NOT LIKE 'zone:%'`
  ).all();
  const normName = (s) => String(s || '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, '')
    .replace(/[\s·・\.、,，!！?？]+/g, '')
    .trim();
  const candidates = [];
  for (const r of (rows.results || [])) {
    const rn = normName(r.real_name);
    const ld = normName(r.line_display);
    if (rn) candidates.push({ name: rn, uid: r.user_id });
    if (ld && ld !== rn) candidates.push({ name: ld, uid: r.user_id });
  }
  // 長名字優先
  candidates.sort((a, b) => b.name.length - a.name.length);
  const normText = normName(trimmed);
  for (const c of candidates) {
    if (c.name.length < 2) continue;
    if (c.uid === userId) continue;
    if (!normText.startsWith(c.name)) continue;
    // 找 normText 去掉 c.name 之後，反推回原 trimmed 的相對位置
    // 簡化：原文裡剝掉任何等同 c.name 的前綴（允許前後插入 emoji/空白）
    const re = new RegExp('^[\\s\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\uFE0F\\u200D]*' +
      c.name.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\uFE0F\\u200D]*') +
      '[\\s:：,，、]*(.*)$', 'u');
    const m = trimmed.match(re);
    const after = (m?.[1] || '').trim();
    if (after.length > 30) continue;
    return { userId: c.uid, text: after || '+1' };
  }
  return null;
}

async function tryProxyZone(env, userId, text) {
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.includes(userId)) return null;

  // 以 zones 表為單一來源（管理員在 /admin/zones 維護）
  const zonesRow = await env.DB.prepare(
    `SELECT name FROM zones WHERE enabled = 1`
  ).all();
  const enabledZones = (zonesRow.results || []).map(r => r.name).filter(Boolean);
  // 加上 zones 表沒列但已在 members 用過的（向下相容）
  const memZonesRow = await env.DB.prepare(
    `SELECT DISTINCT zone FROM members WHERE zone IS NOT NULL AND zone != ''`
  ).all();
  const memZones = (memZonesRow.results || []).map(r => r.zone).filter(Boolean);
  // 去「區」短別名也加入比對（「新化」要能匹到「新化區」）
  const aliases = enabledZones.flatMap(z => z.endsWith('區') ? [z, z.slice(0, -1)] : [z]);
  const all = [...new Set([...aliases, ...memZones])].sort((a, b) => b.length - a.length);

  const canonicalize = (name) =>
    enabledZones.find(n => n === name) ||
    enabledZones.find(n => n === name + '區') ||
    memZones.find(n => n === name) || null;

  // 多區偵測：文字中出現 ≥2 個合法區名 → 拆成多筆
  const foundCanon = [];
  for (const z of all) {
    const canon = canonicalize(z);
    if (!canon || foundCanon.includes(canon)) continue;
    if (text.includes(z)) foundCanon.push(canon);
  }
  if (foundCanon.length >= 2) {
    // 多區代點：不建 member row，回報給 caller 讓他提示使用者分開喊
    return { multi: foundCanon };
  }

  let zoneName = null;
  let stripped = text;

  // 模式 1：幫/替/代/把/為 + <任意名稱> + 點/要/... — 必須是合法區名
  const m1 = text.match(/(?:幫|替|代|把|為)\s*([^\s，,。\.]+?)(?=\s*(?:點|要|來|需要|一個|一份|一杯|一碗|想|吃|喝))/);
  if (m1) {
    const candidate = m1[1].trim();
    const canon = canonicalize(candidate);
    if (canon) {
      zoneName = canon;
      stripped = text.replace(m1[0], '').trim();
    }
  }
  if (!zoneName) {
    // 模式 2：直接出現已知名稱 + 點/要/的/一個
    for (const z of all) {
      const idx = text.indexOf(z);
      if (idx < 0) continue;
      const after = text.slice(idx + z.length);
      const before = text.slice(0, idx);
      if (/^\s*(?:點|要|來|需要|一個|一份|一杯|一碗|的)/.test(after)
          || /(?:幫|替|代|把|為)\s*$/.test(before)) {
        const canon = canonicalize(z);
        if (canon) {
          zoneName = canon;
          stripped = (before + after.replace(/^\s*(?:點|要|來|需要|的)/, '')).replace(/^(?:幫|替|代|把|為)\s*/, '').trim();
          break;
        }
      }
    }
  }

  if (!zoneName) {
    // 模式 3：<區名>+1 / <區名>+1素 / <區名>素 等極簡語法（允許前後空白、冒號、逗號等小符號）
    const trimmed = text.trim();
    for (const z of all) {
      const re = new RegExp('^' + z.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s:：,，、\\-]*(.*)$');
      const m = trimmed.match(re);
      if (!m) continue;
      const after = (m[1] || '').trim();
      if (after.length > 20) continue;
      const canon = canonicalize(z);
      if (!canon) continue;
      zoneName = canon;
      stripped = after || '+1';
      break;
    }
  }

  if (!zoneName) return null;

  const targetId = await resolveZoneTargetId(env, zoneName);
  return { userId: targetId, text: stripped || text };
}

// 若該區已綁某位真人 → 直接用他的 LINE userId（視同本人回覆）；否則 fallback 用 zone:<名> 代點
async function resolveZoneTargetId(env, zoneName) {
  const real = await env.DB.prepare(
    `SELECT user_id FROM members
      WHERE zone = ? AND user_id NOT LIKE 'zone:%'
      ORDER BY last_seen_at DESC LIMIT 1`
  ).bind(zoneName).first();
  if (real?.user_id) return real.user_id;

  const synthId = `zone:${zoneName}`;
  await env.DB.prepare(
    `INSERT INTO members (user_id, real_name, zone, bound_at, last_seen_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at = datetime('now')`
  ).bind(synthId, zoneName, zoneName).run();
  return synthId;
}

// 多區代點用：直接處理單一區的一筆點餐（不走 replyToken，回傳一行確認字串）
async function processProxyOrder(env, task, zoneName, orderText) {
  const targetId = await resolveZoneTargetId(env, zoneName);

  const noFieldsRows = await env.DB.prepare(`SELECT item, field FROM item_no_fields`).all();
  const itemNoFields = {};
  for (const r of (noFieldsRows.results || [])) {
    if (!itemNoFields[r.item]) itemNoFields[r.item] = [];
    itemNoFields[r.item].push(r.field);
  }
  const parsed = await geminiExtract(env.GEMINI_API_KEY, task.task_name, orderText, {}, itemNoFields);
  if (!parsed || !parsed.data || Object.keys(parsed.data).length === 0) {
    return `⚠️ ${zoneName}：無法辨識「${orderText}」`;
  }
  await upsertEntry(env.DB, {
    taskId: task.id, userId: targetId,
    data: parsed.data, note: parsed.note, price: parsed.price,
    rawText: orderText, additive: false,
  });
  const parts = Object.values(parsed.data).filter(Boolean).join('/');
  const price = parsed.price ? ` $${parsed.price}` : '';
  const note = parsed.note ? `（${parsed.note}）` : '';
  return `✅ ${zoneName}：${parts}${price}${note}`;
}

// 硬規則污穢字偵測：體液/排泄物/性器官/中文粗話等
const PROFANITY_RE = /(尿液|尿尿|屎|大便|糞|屁股|精液|嘔吐|鼻屎|痰|月經|經血|陰道|陰莖|雞雞|屌|幹你|幹他|操你|肏|去死|靠北|靠腰|幹話|白癡|智障|低能|f[u\*]ck|shit|bitch|dick|pussy|asshole)/i;
// 明顯非任務相關的閒聊／語助詞／吐槽 → 直接忽略（不進入 profanity 計數、不呼叫 Gemini）
function isChitchat(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // 純表情 / 純標點
  if (/^[\s。.!！?？~～、,，…0-9a-zA-Z]+$/.test(s) && s.length <= 5) return true;
  // 常見口語吐槽、語助詞、抱怨，整句不超過 12 字
  if (s.length > 12) return false;
  const patterns = [
    /^(笑死|笑鼠|笑噴|傻眼|超扯|扯爆|真假的?|我的天啊?|天啊|無言|傻眼貓咪|蛤|齁|哈哈+|呵呵+|笑了|xswl|XD+|嘻嘻+)[\s。.!！?？~～]*$/,
    /^(我哪有|才沒有|哪有|才怪|騙人|誰說的|不是我|不關我事)[\s。.!！?？~～]*$/,
    /^(干你屁事|關你屁事|要你管|管太多|不關你的事|你很煩|別吵|閉嘴)[\s。.!！?？~～]*$/,
    /^(無聊|好累|好煩|累死了?|想睡|煩死了?|好想睡)[\s。.!！?？~～]*$/,
    /^(笨\s*AI|笨機器人|笨小秘|笨蛋\s*AI|爛\s*AI|智障\s*AI|AI\s*很笨|小秘好笨)[\s。.!！?？~～]*$/i,
    /^(不要再問了?|別再問了?|不要吵了?|別吵了?|聽無|聽不懂|不會|不知道啦|隨便啦|都可以|隨便)[\s。.!！?？~～]*$/,
    /^(好[的啦喔呀]?|OK|ok|Ok|收到|嗯+|喔+|哦+|是[喔啊]?|對[啊阿呀]?)[\s。.!！?？~～]*$/,
  ];
  return patterns.some(re => re.test(s));
}

function isProfane(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // 單字「尿」「屎」「糞」等單獨出現也算
  if (/^(尿|屎|糞|屁|痰)$/.test(s)) return true;
  return PROFANITY_RE.test(s);
}

async function handleProfanity(env, task, userId, text, replyToken) {
  const m = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const adminNames = [];
  for (const aid of adminIds) {
    const a = await env.DB.prepare(`SELECT real_name, line_display FROM members WHERE user_id = ?`).bind(aid).first();
    const nm = a?.real_name || a?.line_display;
    if (nm) adminNames.push(nm);
  }
  const adminTag = adminNames.length ? adminNames.map(n => `@${n}`).join(' ') + ' ' : '';

  // 記錄待裁示
  await env.DB.prepare(
    `INSERT INTO pending_profanity (task_id, user_id, last_text, count, last_at)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       last_text = excluded.last_text,
       count = pending_profanity.count + 1,
       last_at = datetime('now')`
  ).bind(task.id, userId, text).run();
  const row = await env.DB.prepare(
    `SELECT count FROM pending_profanity WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  const n = row?.count || 1;

  const msg = n === 1
    ? `${adminTag}${who} 似乎講了不太適合的字眼（「${text}」），麻煩您裁示一下，謝謝 🙏`
    : `${adminTag}${who} 又講了不太適合的字眼（「${text}」，累計 ${n} 次），還在等您裁示，麻煩您處理一下，謝謝 🙏`;
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: msg }]);
}

// 管理員下達：@小秘書 放行 <姓名>、@小秘書 通過 <姓名>、@小秘書 清除 <姓名>
// 或 admin 直接在群組說「放行兆鑫」「通過 兆鑫」等
async function tryClearPendingProfanity(env, task, senderUserId, text, replyToken) {
  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.includes(senderUserId)) return false;
  const m = text.match(/(放行|通過|清除|放過)\s*@?\s*([\u4e00-\u9fa5A-Za-z0-9]+)/);
  if (!m) return false;
  const name = m[2];
  // 找出該名字對應的 user_id
  const target = await env.DB.prepare(
    `SELECT user_id, real_name, line_display FROM members WHERE real_name = ? OR line_display = ? LIMIT 1`
  ).bind(name, name).first();
  if (!target) return false;
  const r = await env.DB.prepare(
    `DELETE FROM pending_profanity WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, target.user_id).run();
  if ((r.meta?.changes || 0) > 0) {
    const who = target.real_name || target.line_display || name;
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{
      type: 'text', text: `✅ 已清除 ${who} 的污穢發言待裁示紀錄，對方可以重新點餐。`,
    }]);
    return true;
  }
  return false;
}

async function handleNonsense(env, task, userId, text, replyToken, teaseFromAI, hasExisting) {
  const row = await env.DB.prepare(
    `SELECT count FROM nonsense_strikes WHERE task_id = ? AND user_id = ?`
  ).bind(task.id, userId).first();
  const count = (row?.count || 0) + 1;
  await env.DB.prepare(
    `INSERT INTO nonsense_strikes (task_id, user_id, count, last_text, last_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(task_id, user_id) DO UPDATE SET
       count = excluded.count, last_text = excluded.last_text, last_at = datetime('now')`
  ).bind(task.id, userId, count, text).run();

  const m = await env.DB.prepare(
    `SELECT real_name, line_display FROM members WHERE user_id = ?`
  ).bind(userId).first();
  const who = m?.real_name || m?.line_display || userId.slice(0, 6);

  // 未點狀態：模糊/矛盾比較正常，第 1 次 AI 吐槽留空間；第 2 次起才 @ 管理員
  // 已點狀態：已經有有效紀錄，任何矛盾發言直接 @ 管理員（不再吐槽浪費時間）
  if (!hasExisting && count === 1) {
    const tease = teaseFromAI || '您這個描述我沒辦法幫您點，麻煩再提供一次正確的品項，謝謝您 🙏';
    await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: tease }]);
    return;
  }

  const adminIds = String(env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const adminNames = [];
  for (const aid of adminIds) {
    const a = await env.DB.prepare(
      `SELECT real_name, line_display FROM members WHERE user_id = ?`
    ).bind(aid).first();
    const nm = a?.real_name || a?.line_display;
    if (nm) adminNames.push(nm);
  }
  const adminTag = adminNames.length ? adminNames.map(n => `@${n}`).join(' ') + ' ' : '';
  const context = hasExisting
    ? `${who} 已有紀錄，剛剛又講「${text}」，似乎在開玩笑或矛盾`
    : `${who} 最後一次點了「${text}」，內容不太合理`;
  const reply = `${adminTag}${context}，麻煩您協助裁示一下，謝謝 🙏`;
  await lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, [{ type: 'text', text: reply }]);
}

async function upsertMemberSighting(DB, userId, groupId, token) {
  if (!DB) return;
  try {
    let display = null, avatar = null;
    if (groupId) {
      const p = await getGroupMemberProfile(token, groupId, userId);
      if (p) { display = p.displayName; avatar = p.pictureUrl; }
    } else {
      const p = await getUserProfile(token, userId);
      if (p) { display = p.displayName; avatar = p.pictureUrl; }
    }
    await DB.prepare(
      `INSERT INTO members (user_id, line_display, line_avatar, last_seen_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         line_display = COALESCE(excluded.line_display, line_display),
         line_avatar  = COALESCE(excluded.line_avatar, line_avatar),
         last_seen_at = datetime('now')`
    ).bind(userId, display, avatar).run();
    // 自動比對 roster：若 LINE 顯示名能唯一對上 roster 的 real_name → 綁定 + 補 zone
    if (display) {
      const existing = await DB.prepare(
        `SELECT real_name, zone FROM members WHERE user_id = ?`
      ).bind(userId).first();
      const alreadyBound = !!(existing?.real_name && existing?.zone);
      if (!alreadyBound) {
        // 模糊比對：去 emoji / 括號註解後，只保留中文字
        const stripBrackets = (s) => String(s || '')
          .replace(/[\p{Extended_Pictographic}\p{Emoji_Component}]/gu, '')
          .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '');
        const cjkOnly = (s) => (String(s || '').match(/[\u4e00-\u9fff]+/g) || []).join('');
        const dispCJK = cjkOnly(stripBrackets(display));
        if (dispCJK) {
          const rosterRows = await DB.prepare(
            `SELECT id, real_name, zone FROM roster WHERE user_id IS NULL`
          ).all();
          const rows = rosterRows.results || [];
          const matches = rows.filter(r => {
            const rn = cjkOnly(r.real_name);
            if (!rn) return false;
            // 1. 完全相同
            if (rn === dispCJK) return true;
            // 2. roster 全名出現在顯示名中（涵蓋「陳芊伃-官田」「Candy  盧昭吟-股長」等）
            if (dispCJK.includes(rn)) return true;
            // 3. roster 尾 N 字 == 顯示名前 N 字（涵蓋「麗萍-關廟」「嘉玟-永康」「兆鑫」等只有名字的情況）
            for (const n of [2, 3]) {
              if (rn.length >= n && dispCJK.length >= n) {
                if (rn.slice(-n) === dispCJK.slice(0, n)) return true;
              }
            }
            return false;
          });
          if (matches.length === 1) {
            const m = matches[0];
            await DB.prepare(
              `UPDATE roster SET user_id = ?, bound_at = datetime('now') WHERE id = ?`
            ).bind(userId, m.id).run();
            await DB.prepare(
              `UPDATE members SET real_name = ?, zone = ? WHERE user_id = ?`
            ).bind(m.real_name, m.zone, userId).run();
            console.log('[roster auto-bind]', userId, '→', m.real_name, m.zone);
          }
        }
      }
    }
  } catch (e) {
    console.error('[upsert member] fail:', e);
  }
}

// 菜單提示訊息（以網址取代圖片 PO，避免多則訊息；每 task 60 秒冷卻）
async function maybeMenuMessages(env, task) {
  if (!task?.menu_json) return [];
  const DB = env.DB;
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS menu_push_log (task_id INTEGER PRIMARY KEY, pushed_at TEXT)`
  ).run();
  const r = await DB.prepare(
    `SELECT pushed_at FROM menu_push_log WHERE task_id = ?`
  ).bind(task.id).first();
  if (r?.pushed_at) {
    const last = Date.parse(String(r.pushed_at).replace(' ', 'T') + 'Z');
    if (!isNaN(last) && Date.now() - last < 60_000) return [];
  }
  const photoCount = await DB.prepare(
    `SELECT COUNT(*) AS c FROM menu_photos WHERE task_id = ?`
  ).bind(task.id).first();
  if (!photoCount?.c) return [];
  await DB.prepare(
    `INSERT INTO menu_push_log (task_id, pushed_at) VALUES (?, datetime('now'))
     ON CONFLICT(task_id) DO UPDATE SET pushed_at = excluded.pushed_at`
  ).bind(task.id).run();
  const host = env.PUBLIC_HOST || 'https://assist-gcl.pages.dev';
  const url = `${host}/t/${task.url_slug || task.id}`;
  return [{
    type: 'text',
    text: `📷 ${task.task_name} 菜單：${url}`,
  }];
}

// 模糊匹配菜單品項
// 回傳：{ matched: [candidates...] }；長度 0=無匹配，1=唯一對應，2+=需讓使用者選
function matchMenuCandidates(menuItems, itemName) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const target = norm(itemName);
  if (!target || !Array.isArray(menuItems)) return [];
  // 1) 完全相同
  const exact = menuItems.filter(it => norm(it.name) === target);
  if (exact.length === 1) return exact;
  if (exact.length > 1) return exact;
  // 2) 包含關係
  const partial = menuItems.filter(it => {
    const n = norm(it.name);
    return n && (n.includes(target) || target.includes(n));
  });
  return partial;
}
