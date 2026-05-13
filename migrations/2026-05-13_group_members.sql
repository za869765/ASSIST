-- v1.0.33 per-group 成員設定：同一 LINE user 在不同群可有不同 real_name / zone
-- 顯示優先讀 group_members（有就用），fallback 全域 members

CREATE TABLE IF NOT EXISTS group_members (
  group_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  real_name    TEXT,
  zone         TEXT,
  last_seen_at TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user  ON group_members(user_id);

-- Backfill：依「該 user 曾在哪些群訂單」展開既有 members 全域設定
-- 之後 webhook 寫入 entries 時也會同步 upsert group_members（v1.0.34 起）
INSERT OR IGNORE INTO group_members (group_id, user_id, real_name, zone, last_seen_at)
SELECT DISTINCT t.group_id, e.user_id, m.real_name, m.zone, m.last_seen_at
  FROM entries e
  INNER JOIN tasks t ON t.id = e.task_id
  LEFT JOIN members m ON m.user_id = e.user_id
 WHERE t.group_id IS NOT NULL
   AND e.user_id IS NOT NULL
   AND e.user_id NOT LIKE 'web:%'
   AND e.user_id NOT LIKE 'zone:%'
   AND e.user_id NOT LIKE '網址:%';
