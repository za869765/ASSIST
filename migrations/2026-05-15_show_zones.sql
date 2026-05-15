-- v1.0.40 groups.show_zones：群組設定是否在看板按區分類顯示
-- 0 = 不分區（純按 entry 順序列名字，適合全群同一區的場景，例：佳里區衛生所訂餐群）
-- 1 = 分區顯示（預設，維持現有行為）

ALTER TABLE groups ADD COLUMN show_zones INTEGER NOT NULL DEFAULT 1;
