-- 2026-04-18：新增 zones 表 + 種子資料（36 區扣安平 + 檢驗中心）
CREATE TABLE IF NOT EXISTS zones (
  name         TEXT PRIMARY KEY,
  capacity     INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- 6 個原市區（扣安平 → 5）
INSERT OR IGNORE INTO zones (name, capacity, enabled, sort_order) VALUES
  ('中西區', 1, 1, 10),
  ('東區',   1, 1, 11),
  ('南區',   1, 1, 12),
  ('北區',   1, 1, 13),
  ('安南區', 1, 1, 14),
  ('安平區', 1, 0, 15);  -- 預設關閉，要用再開

-- 31 個改制區（鄉鎮升格）
INSERT OR IGNORE INTO zones (name, capacity, enabled, sort_order) VALUES
  ('永康區', 1, 1, 20),
  ('歸仁區', 1, 1, 21),
  ('新化區', 1, 1, 22),
  ('左鎮區', 1, 1, 23),
  ('玉井區', 1, 1, 24),
  ('楠西區', 1, 1, 25),
  ('南化區', 1, 1, 26),
  ('仁德區', 1, 1, 27),
  ('關廟區', 1, 1, 28),
  ('龍崎區', 1, 1, 29),
  ('官田區', 1, 1, 30),
  ('麻豆區', 1, 1, 31),
  ('佳里區', 1, 1, 32),
  ('西港區', 1, 1, 33),
  ('七股區', 1, 1, 34),
  ('將軍區', 1, 1, 35),
  ('學甲區', 1, 1, 36),
  ('北門區', 1, 1, 37),
  ('新營區', 1, 1, 38),
  ('後壁區', 1, 1, 39),
  ('白河區', 1, 1, 40),
  ('東山區', 1, 1, 41),
  ('六甲區', 1, 1, 42),
  ('下營區', 1, 1, 43),
  ('柳營區', 1, 1, 44),
  ('鹽水區', 1, 1, 45),
  ('善化區', 1, 1, 46),
  ('大內區', 1, 1, 47),
  ('山上區', 1, 1, 48),
  ('新市區', 1, 1, 49),
  ('安定區', 1, 1, 50);

-- 單位（檢驗中心 = 不限）
INSERT OR IGNORE INTO zones (name, capacity, enabled, sort_order) VALUES
  ('檢驗中心', 0, 1, 100);
