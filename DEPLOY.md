# ASSIST 部署指南（M1）

## 一、Cloudflare 設定

### 1. 建立 D1 資料庫
到 Cloudflare dashboard → D1 → Create database
- Name: `assist_db`
- Region: 就近選
- 建立後複製 **Database ID** 填入 `wrangler.toml`

### 2. 匯入 schema
dashboard → D1 → assist_db → Console，貼入 `schema.sql` 全部內容執行。

> **v1.0.27 升級**：另外執行 `migrations/2026-05-13_admin_backoffice.sql`（新增 `admins`、`groups` 兩張表，給後台管理用）。

### 3. 建立 Pages 專案
Pages → Create → Connect to Git → 選 `za869765/ASSIST`
- Build command: 留空
- Build output directory: `.`（根目錄）
- Environment variables（Production）：
  - `LINE_CHANNEL_SECRET` = （從 LINE Developers Console「小秘書」Channel 取得）
  - `LINE_CHANNEL_ACCESS_TOKEN` = （同上）
  - `GEMINI_API_KEY` = （從 https://aistudio.google.com/app/apikey 建立；絕對不可 commit 到 repo）
  - `ADMIN_USER_IDS` = （您本人的 userId，作為「無法被線上刪除」的根管理員；之後可在後台加更多管理員不必 redeploy）
  - `ADMIN_PASS` = **v1.0.27 起必填**（進入 `/admin` 後台的密碼，建議至少 12 碼隨機字串）
- Functions → D1 database bindings：
  - Variable name: `DB`
  - D1 database: `assist_db`

### 4. 取得部署網址
例如 `https://assist.pages.dev`

## 二、LINE 設定

### 1. 取 Channel Secret / Access Token
到 [LINE Developers Console](https://developers.line.biz/) → 選小秘書所屬 Provider → Messaging API Channel
- 複製 **Channel secret**
- **Channel access token (long-lived)** → Issue 一個

### 2. 設 Webhook
Messaging API 設定頁：
- Webhook URL: `https://assist.pages.dev/api/line/webhook`
- Use webhook: **ON**
- Auto-reply messages: **OFF**
- Greeting messages: 隨意

### 3. 驗證
點 Verify，應該回 200。

## 三、取得 userId 並建白名單

1. 小秘書已加好友的人，傳訊「TAQ 小秘書 我的ID」，會回自己的 userId
2. 把 userId 填到 Cloudflare Pages Environment variables 的 `ADMIN_USER_IDS`
3. 多位用逗號分隔：`Uabc123...,Udef456...`
4. 重新部署（Cloudflare Pages → Deployments → Retry deployment）

## 四、M1 驗證

### 私聊測試
1. 傳「TAQ 小秘書 我的ID」→ 應該回您的 userId
2. 傳「TAQ 小秘書 ping」→ 若您是管理員，應該回 pong + 環境摘要
3. 隨便傳「TAQ 小秘書 幫我統計飲料」→ 會 echo 顯示已收到

### 群組測試
1. 把小秘書加進一個測試群
2. 在群組裡傳「TAQ 小秘書 我的ID」→ 應該回該人 userId
3. 非管理員傳 TAQ 任何其他指令 → 回「權限不足」
4. 檢查 `/api/health` → D1 應該已累積 member 資料（last_seen_at）

---

完成以上即 M1 通關。接下來進 M2（Gemini 意圖解析）。

## 五、v1.0.27 後台（M6 完成）

部署後直接打開 `https://<your-domain>/admin`，輸入 `ADMIN_PASS` 進入。

- **總覽**：服務狀態（含 D1/secrets/admin 統計）
- **管理員白名單**：env CSV 顯示為「不可刪」，可新增 D1 管理員（30 秒內 webhook 認得，不必 redeploy）
- **群組設定**：列出 bot 進過的群組，可加備註別名 / 啟用停用（停用後該群非管理員訊息一律 silent）
- **歷史任務**：列出所有任務（含進行中、已結單），重新下載 Excel 連結
- 既有 `/admin/zones` 分區頁也可直接從後台首頁進入
