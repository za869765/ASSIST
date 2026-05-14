-- v1.0.36 計價模式 + 會員身份
-- tasks: 計價模式（4 模式 + travel 預留）、總額（合菜用）、會員補助（per-task 覆寫，預設 400）
-- members: 是否會員 flag（admin 手設；非會員 = 0 = 預設）

ALTER TABLE tasks ADD COLUMN pricing_mode TEXT DEFAULT 'free_bento';
ALTER TABLE tasks ADD COLUMN total_amount INTEGER;
ALTER TABLE tasks ADD COLUMN member_subsidy INTEGER DEFAULT 400;

ALTER TABLE members ADD COLUMN is_member INTEGER DEFAULT 0;

-- pricing_mode 預期值（CHECK 約束 D1 不便加；前後端嚴格驗證即可）：
--   'free_bento' = 模式1 無菜單便當（一律 $0）
--   'menu'       = 模式2 菜單（簡餐／套餐）
--   'shared'     = 模式3 合菜（共享總額）
--   'drink'      = 模式4 飲料（強制甜度/冰塊）
--   'travel'     = 模式5 會員旅遊（schema 預留，UI/結算未實作）
