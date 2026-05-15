-- v1.0.48 買五送一：任務級別開關
-- 0 = 不啟用（預設）
-- 1 = 每 6 杯，組內最便宜的 1 杯免費（總額折扣）

ALTER TABLE tasks ADD COLUMN buy5_get1 INTEGER NOT NULL DEFAULT 0;
