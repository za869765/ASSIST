-- ASSIST D1 schema

-- 成員名冊：LINE userId ↔ 正式姓名 ↔ 分組
CREATE TABLE IF NOT EXISTS members (
  user_id      TEXT PRIMARY KEY,
  real_name    TEXT,
  zone         TEXT,
  is_admin     INTEGER DEFAULT 0,
  line_display TEXT,               -- 最近一次看到的 LINE 暱稱（僅供辨識）
  line_avatar  TEXT,
  bound_at     TEXT,               -- 綁定時間（未綁定 = null）
  last_seen_at TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_members_bound ON members(bound_at);

-- 任務（每次開的統計主題）
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id     TEXT NOT NULL,
  task_name    TEXT NOT NULL,
  fields_json  TEXT NOT NULL DEFAULT '[]',   -- 要收的欄位（AI 決定）
  menu_json    TEXT,                          -- 菜單（OCR 結果，可空 = 自由模式）
  mode         TEXT DEFAULT 'free',           -- 'free' | 'menu'
  status       TEXT DEFAULT 'open',           -- 'open' | 'closed'
  started_by   TEXT NOT NULL,
  started_at   TEXT DEFAULT (datetime('now')),
  closed_at    TEXT,
  excel_url    TEXT                           -- 結案後 Excel 連結
);
CREATE INDEX IF NOT EXISTS idx_tasks_group_status ON tasks(group_id, status);

-- 訂單 / 紀錄（每人針對該任務的資料）
CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  data_json    TEXT NOT NULL DEFAULT '{}',    -- 動態欄位（品項/甜度/冰塊/葷素…）
  note         TEXT,                           -- 特殊需求（不要香菜、過敏）
  price        INTEGER,
  confirmed    INTEGER DEFAULT 0,              -- 所有必填欄位是否齊全
  raw_texts    TEXT DEFAULT '[]',              -- 原始發言串（JSON array）
  updated_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_task ON entries(task_id);

-- 例外裁決（菜單外項目、堅持請求等）
CREATE TABLE IF NOT EXISTS exceptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  raw_text     TEXT NOT NULL,
  issue        TEXT,                           -- 問題描述（AI 產）
  resolution   TEXT,                           -- 'allow' | 'deny' | 'redirect'
  resolved_by  TEXT,
  resolved_at  TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- 對話除錯紀錄（Gemini 輸入輸出留存，除錯 + 調參考）
CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER,
  group_id     TEXT,
  user_id      TEXT,
  direction    TEXT,                           -- 'in' | 'out'
  raw_text     TEXT,
  gemini_json  TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_task ON conversations(task_id);

-- 惡搞/矛盾訂單累積（第 2 次觸發管理員裁定）
CREATE TABLE IF NOT EXISTS nonsense_strikes (
  task_id      INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  last_text    TEXT,
  last_at      TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, user_id)
);

-- 同義詞對照（學習累積，給 Gemini 當 few-shot 參考）
CREATE TABLE IF NOT EXISTS synonyms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical    TEXT NOT NULL,                  -- 標準品名
  alias        TEXT NOT NULL,                  -- 別名 / 俗寫
  category     TEXT,                           -- 'drink' | 'meal' | 'bento' ...
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(canonical, alias)
);
