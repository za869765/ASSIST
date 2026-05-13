-- v1.0.27 後台管理：D1 化管理員白名單 + 群組設定表

-- 管理員白名單（補 env.ADMIN_USER_IDS 之外的線上管理員）
CREATE TABLE IF NOT EXISTS admins (
  user_id    TEXT PRIMARY KEY,
  note       TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT
);

-- 群組設定（每個 LINE 群組可獨立啟用/停用 + 加備註別名）
CREATE TABLE IF NOT EXISTS groups (
  group_id        TEXT PRIMARY KEY,
  alias           TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TEXT DEFAULT (datetime('now')),
  last_active_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_groups_enabled ON groups(enabled);
