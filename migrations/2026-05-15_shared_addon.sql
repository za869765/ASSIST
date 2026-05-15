-- v1.0.50 共同袋子成本 + 多付清單跨任務累計

-- tasks 加 shared_addon：任務級別「共同成本」（例：白巷子大袋 2 元）
-- 加進總應收 = sum(entry.price) - buy5_discount + shared_addon
ALTER TABLE tasks ADD COLUMN shared_addon INTEGER NOT NULL DEFAULT 0;

-- group_member_balance：每個群組每個成員的「累計多付次數」
-- 平均分攤時若有餘數，從 overpaid_count 最少的人開始挑當「多付 1 元」
-- 結算完成才更新（增加多付者的 overpaid_count；袋子共同成本部份不算多付）
CREATE TABLE IF NOT EXISTS group_member_balance (
  group_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  overpaid_count  INTEGER NOT NULL DEFAULT 0,  -- 累計多付 1 元的次數
  last_updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_balance_group ON group_member_balance(group_id, overpaid_count ASC);
