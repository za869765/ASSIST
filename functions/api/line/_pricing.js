// v1.0.38 計價 helper：純函式，給 _xlsx / webhook 共用
// task: { pricing_mode, total_amount, member_subsidy, mode, task_name? }
// entries: listEntries() 出來的 row，含 is_member（v1.0.37 加）
//
// 規則參考 project_assist_pricing_rules.md：
//   - 基本額（base_deduction）= 100，固定
//   - 模式 1 free_bento：一律 $0
//   - 模式 2 menu / 模式 4 drink：基礎應收 = menu_price - 100
//       會員付 = max(0, 基礎 - subsidy)
//       非會員付 = 基礎
//   - 模式 3 shared（合菜，共享 total_amount）：
//       共餐人數 = 會員 + 共餐非會員（含未分類者預設算共餐）
//       人均 = total / 共餐人數；差額 = 人均 - 100
//       會員付 = max(0, 差額 - subsidy)，非會員(共餐)付 = 差額
//       協助訂便當非會員付 $0（$100 由便當店發票出）
//       發票 A = 共餐人數 × 100；發票 B = total - A
//       便當店發票 = 訂便當人數 × 100（獨立一張，不併入合菜廠商）
//   - 模式 5 travel：schema 預留，notImplemented = true
//
// 回傳：{ mode, perEntry: [{entry, identity, ...}], summary: {...} }

const BASE_DEDUCTION = 100;
const DEFAULT_SUBSIDY = 400;
const ALLOWED_MODES = ['free_bento', 'menu', 'shared', 'drink', 'travel'];

export function computePricing(task, entries) {
  const mode = ALLOWED_MODES.includes(task?.pricing_mode) ? task.pricing_mode : 'free_bento';
  const subsidy = task?.member_subsidy == null ? DEFAULT_SUBSIDY : Math.max(0, +task.member_subsidy || 0);
  const totalAmount = task?.total_amount == null ? 0 : Math.max(0, +task.total_amount || 0);
  const list = Array.isArray(entries) ? entries : [];

  const isLeave = (e) => e?.note === '請假' || e?.note === '不吃';
  const isWeb = (e) => String(e?.user_id || '').startsWith('web:');
  const isMember = (e) => !isWeb(e) && !!e?.is_member;
  const parseData = (e) => {
    if (e?.data && typeof e.data === 'object') return e.data;
    try { return JSON.parse(e?.data_json || '{}'); } catch { return {}; }
  };

  const valid = list.filter(e => !isLeave(e));

  if (mode === 'travel') {
    return {
      mode,
      notImplemented: true,
      perEntry: [],
      summary: { note: '會員旅遊模式（v1.0.38 預留，結算未實作）' },
    };
  }

  if (mode === 'free_bento') {
    const perEntry = valid.map(e => ({
      entry: e,
      identity: isMember(e) ? 'member' : 'non_member',
      menu_price: 0, base: 0, due: 0,
    }));
    return {
      mode, perEntry,
      summary: {
        member_count: perEntry.filter(x => x.identity === 'member').length,
        non_member_count: perEntry.filter(x => x.identity === 'non_member').length,
        total_payable: 0,
        subsidy_total: 0,
        invoice_a: 0, invoice_b: 0, bento_invoice: 0,
      },
    };
  }

  if (mode === 'menu' || mode === 'drink') {
    const perEntry = valid.map(e => {
      const price = +e.price || 0;
      const base = Math.max(0, price - BASE_DEDUCTION);
      const isM = isMember(e);
      const due = isM ? Math.max(0, base - subsidy) : base;
      return { entry: e, identity: isM ? 'member' : 'non_member', menu_price: price, base, due };
    });
    const members = perEntry.filter(x => x.identity === 'member');
    const nonMembers = perEntry.filter(x => x.identity === 'non_member');
    const memberPay = members.reduce((s, x) => s + x.due, 0);
    const nonMemberPay = nonMembers.reduce((s, x) => s + x.due, 0);
    const subsidyTotal = members.reduce((s, x) => s + (x.base - x.due), 0);
    const totalMenuPrice = perEntry.reduce((s, x) => s + x.menu_price, 0);
    const invoiceA = BASE_DEDUCTION * perEntry.length;
    const invoiceB = Math.max(0, totalMenuPrice - invoiceA);
    return {
      mode, perEntry,
      summary: {
        member_count: members.length,
        non_member_count: nonMembers.length,
        total_menu_price: totalMenuPrice,
        member_pay: memberPay,
        non_member_pay: nonMemberPay,
        total_payable: memberPay + nonMemberPay,
        subsidy_total: subsidyTotal,
        invoice_a: invoiceA,
        invoice_b: invoiceB,
        bento_invoice: 0,
      },
    };
  }

  // shared 合菜
  const annotated = valid.map(e => {
    const data = parseData(e);
    const isM = isMember(e);
    const join = !!data.guest_join;
    const bento = !!data.guest_bento;
    // 預設：未分類非會員 → 算共餐（穩妥預設，避免漏算）
    const sharedDiner = isM || join || (!isM && !join && !bento);
    const bentoType = data.bento_type === '素' ? '素' : '葷';
    return { entry: e, data, isM, sharedDiner, bento, bentoType };
  });

  const sharedDinersCount = annotated.filter(x => x.sharedDiner).length;
  const bentoCount = annotated.filter(x => !x.isM && x.bento && !x.sharedDiner).length;
  // 雙勾共餐+便當的人，便當算另開、共餐分母也算
  const dualCount = annotated.filter(x => !x.isM && x.bento && x.sharedDiner).length;
  const bentoInvoiceCount = bentoCount + dualCount;

  const perDinerRaw = sharedDinersCount > 0 ? totalAmount / sharedDinersCount : 0;
  const diff = Math.max(0, perDinerRaw - BASE_DEDUCTION);

  const perEntry = annotated.map(({ entry, isM, sharedDiner, bento, bentoType }) => {
    let due = 0;
    if (sharedDiner) {
      due = isM ? Math.max(0, diff - subsidy) : diff;
    } else if (bento) {
      due = 0;
    }
    return {
      entry,
      identity: isM ? 'member' : 'non_member',
      guest_join: !isM && sharedDiner,
      guest_bento: !isM && bento,
      bento_type: !isM && bento ? bentoType : null,
      per_diner: sharedDiner ? Math.round(perDinerRaw) : 0,
      diff: sharedDiner ? diff : 0,
      due: Math.round(due),
    };
  });

  const members = perEntry.filter(x => x.identity === 'member');
  const memberPay = members.reduce((s, x) => s + x.due, 0);
  const nonMemberSharedPay = perEntry
    .filter(x => x.identity === 'non_member' && x.guest_join)
    .reduce((s, x) => s + x.due, 0);
  const memberSubsidyTotal = members.reduce((s, x) => s + (x.diff - x.due), 0);

  const invoiceA = BASE_DEDUCTION * sharedDinersCount;
  const invoiceB = Math.max(0, totalAmount - invoiceA);
  const bentoInvoice = BASE_DEDUCTION * bentoInvoiceCount;

  return {
    mode, perEntry,
    summary: {
      shared_diners: sharedDinersCount,
      bento_count: bentoInvoiceCount,
      member_count: members.length,
      non_member_count: perEntry.filter(x => x.identity === 'non_member').length,
      total_amount: totalAmount,
      per_diner: Math.round(perDinerRaw),
      diff: Math.round(diff),
      member_pay: memberPay,
      non_member_pay: nonMemberSharedPay,
      total_payable: memberPay + nonMemberSharedPay,
      subsidy_total: memberSubsidyTotal,
      invoice_a: invoiceA,
      invoice_b: invoiceB,
      bento_invoice: bentoInvoice,
    },
  };
}

// v1.0.51 買五送一規則（依實際白巷子店家規則修正）：
//   對 valid entries（已過濾請假）按 price 升序分組，每 6 杯一組
//   組內【最貴】那杯免費（即 sorted 第 6 個 = i+5）
//   注意：只有完整 6 杯才送，剩餘不足 6 不送
// 輸入：entries（含 id 與 price）
// 輸出：{ freeIds: Set<entry.id>, discount: number, groupsApplied: number }
export function applyBuy5Get1(entries) {
  const list = (entries || []).filter(e => e && e.note !== '請假' && e.note !== '不吃');
  // 按 price 升序；無 price 視為 0 排最前
  const sorted = [...list].sort((a, b) => (+a.price || 0) - (+b.price || 0));
  const freeIds = new Set();
  let discount = 0;
  let groupsApplied = 0;
  for (let i = 0; i + 6 <= sorted.length; i += 6) {
    // 組內最貴 = sorted[i+5]（每 6 杯一組的最後一個）
    const mostExpensive = sorted[i + 5];
    if (mostExpensive && mostExpensive.id != null) {
      freeIds.add(mostExpensive.id);
      discount += +mostExpensive.price || 0;
      groupsApplied++;
    }
  }
  return { freeIds, discount, groupsApplied };
}

// 結算結果可選的中文標籤（XLSX 用）
export const MODE_LABEL = {
  free_bento: '無菜單便當',
  menu: '菜單',
  shared: '合菜',
  drink: '飲料',
  travel: '會員旅遊（未實作）',
};

export const IDENTITY_LABEL = {
  member: '會員',
  non_member: '非會員',
};
