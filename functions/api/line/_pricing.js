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

// ── 旅遊模式（v1.0.62）：移植 travel_calc 金流 ──
//   應繳 = 行程成本(收據金額，不加稅) − 聯繫會補助；實際自付 = 應繳 − 文康補助
//   金額 = 收據金額 + 加權發票金額；發票金額(預設 文康人數×1000，可改) ×1.05 = 加權發票
const TRAVEL_DEFAULTS = {
  twoCost: { 30:{two:4970,four:4370}, 25:{two:5454,four:4854}, 20:{two:5470,four:4870} },
  oneDayPrice: 2000,
  subTwo: { member:{liaison:1200,wellness:1000}, nonmember:{liaison:0,wellness:0}, retired:{liaison:600,wellness:0} },
  // 一日專屬規則（與兩日不同）：會員自付一律 0（只付文康、文康以外由聯繫會補）；離退固定聯繫會補助；非會員全額
  oneDay: { memberWellness: 1000, retiredLiaison: 300 },
};
export const TRAVEL_ROLE_OF = { '會員':'member', '非會員':'nonmember', '員眷':'nonmember', '眷屬':'nonmember', '員工眷屬':'nonmember', '離退會員':'retired', '離退':'retired', '退休':'retired' };
export const TRAVEL_ROOM_OF = { '兩人房':'two', '四人房':'four', '2人房':'two', '4人房':'four', '雙人房':'two' };
export const TRAVEL_ROLE_LABEL = { member:'會員', nonmember:'非會員', retired:'離退會員' };
export const TRAVEL_ROOM_LABEL = { two:'兩人房', four:'四人房' };

export function travelConfig(task) {
  let c = {};
  try { c = task?.travel_json ? JSON.parse(task.travel_json) : {}; } catch { c = {}; }
  return {
    tripType: c.tripType === 'one' ? 'one' : 'two',
    tier: [30,25,20].includes(+c.tier) ? +c.tier : 30,
    twoCost: c.twoCost || TRAVEL_DEFAULTS.twoCost,
    oneDayPrice: c.oneDayPrice == null ? TRAVEL_DEFAULTS.oneDayPrice : Math.max(0, +c.oneDayPrice || 0),
    subTwo: c.subTwo || TRAVEL_DEFAULTS.subTwo,
    oneDay: c.oneDay || TRAVEL_DEFAULTS.oneDay,
    // 發票金額(未稅)：null = 預設用文康總額；看板可覆寫。invoiceRate 預設 5%
    invoiceBase: (c.invoiceBase == null || c.invoiceBase === '') ? null : Math.max(0, +c.invoiceBase || 0),
    invoiceRate: c.invoiceRate == null ? 0.05 : Math.max(0, +c.invoiceRate || 0),
  };
}
function travelCost(cfg, room) {
  // 收據金額 = 報價/成本原值（不加稅；發票稅另計於加權發票）
  return cfg.tripType === 'two' ? ((cfg.twoCost[cfg.tier] || {})[room] || 0) : cfg.oneDayPrice;
}
export function travelPerPerson(cfg, role, room) {
  const cost = travelCost(cfg, room);
  if (cfg.tripType === 'two') {
    const sub = (cfg.subTwo || {})[role] || { liaison:0, wellness:0 };
    const liaison = Math.max(0, +sub.liaison || 0);
    const wellness = Math.max(0, +sub.wellness || 0);
    const due = Math.max(0, cost - liaison);
    return { cost, liaison, wellness, due, self_pay: due - wellness };
  }
  // 一日（結構與兩日不同）
  const o = cfg.oneDay || {};
  if (role === 'member') {
    // 會員只付文康，文康以外由聯繫會補 → 自付一律 0
    const wellness = Math.min(cost, Math.max(0, +(o.memberWellness ?? 1000)));
    return { cost, liaison: cost - wellness, wellness, due: wellness, self_pay: 0 };
  }
  if (role === 'retired') {
    // 離退：固定聯繫會補助，其餘自付
    const liaison = Math.max(0, +(o.retiredLiaison ?? 300));
    const due = Math.max(0, cost - liaison);
    return { cost, liaison, wellness: 0, due, self_pay: due };
  }
  // 非會員：全額
  return { cost, liaison: 0, wellness: 0, due: cost, self_pay: cost };
}

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
    const cfg = travelConfig(task);
    const perEntry = valid.map((e) => {
      const data = parseData(e);
      const role = TRAVEL_ROLE_OF[String(data['身份'] || '').trim()] || (isMember(e) ? 'member' : 'nonmember');
      const room = cfg.tripType === 'two' ? (TRAVEL_ROOM_OF[String(data['房型'] || '').trim()] || 'two') : 'two';
      const c = travelPerPerson(cfg, role, room);
      return {
        entry: e, identity: role, room,
        cost: c.cost, liaison: c.liaison, wellness: c.wellness, due: c.due, self_pay: c.self_pay,
      };
    });
    const sum = (f) => perEntry.reduce((s, x) => s + f(x), 0);
    const cnt = (r) => perEntry.filter((x) => x.identity === r).length;
    const totalDue = sum((x) => x.due);
    const wellnessTotal = sum((x) => x.wellness);          // 文康總額 = 文康人數 × 1000
    const totalCost = sum((x) => x.cost);                  // 報價總額
    const invoiceBase = cfg.invoiceBase == null ? wellnessTotal : cfg.invoiceBase;  // 發票金額（不加權、固定）
    const invoiceTax = Math.round(invoiceBase * (cfg.invoiceRate ?? 0.05));         // 發票稅 5%（計入收據/總額，發票金額不變）
    const receiptAmount = (totalDue - invoiceBase) + invoiceTax;                    // 收據金額 = (總應繳 − 發票金額) + 稅
    return {
      mode, perEntry, travel: cfg,
      summary: {
        trip: cfg.tripType === 'two' ? '兩日遊' : '一日遊',
        tier: cfg.tripType === 'two' ? cfg.tier : null,
        member_count: cnt('member'),
        non_member_count: cnt('nonmember'),
        retired_count: cnt('retired'),
        total_cost: totalCost,
        liaison_total: sum((x) => x.liaison),
        wellness_total: wellnessTotal,
        self_pay_total: sum((x) => x.self_pay),
        total_payable: totalDue,
        subsidy_total: sum((x) => x.liaison),
        invoice_base: invoiceBase,             // 發票金額（= 文康，預設可改；不加權、固定）
        invoice_tax: invoiceTax,               // 發票稅（5%，計入收據與總額）
        receipt_amount: receiptAmount,         // 收據金額（= 總應繳 − 發票金額 + 稅）
        grand_total: receiptAmount + invoiceBase,   // 總金額 = 收據金額 + 發票金額
        vendor_total: totalCost + invoiceTax,       // 廠商總金額 = 報價總額 + 發票稅
      },
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
  travel: '會員旅遊',
};

export const IDENTITY_LABEL = {
  member: '會員',
  non_member: '非會員',
  nonmember: '非會員',
  retired: '離退會員',
};
