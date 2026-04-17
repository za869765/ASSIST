# 小秘書 LINE Bot (ASSIST)

以 AI 為核心的 LINE 群組助理，把傳統「接龍統計」自動化 —
群組成員自然說話，小秘書用 Gemini 智慧解析、歸一、補問、結案產 Excel。

## 架構
- **Cloudflare Pages + Pages Functions**（Workers 執行環境）
- **D1**（SQLite）儲存名冊、任務、訂單
- **LINE Messaging API**（官方帳號：小秘書 @361bwkrz）
- **Google Gemini API**（多模態，支援文字與圖片 OCR）

## 目錄結構
```
ASSIST/
├─ functions/api/
│   ├─ line/webhook.js      LINE 入口（收訊 + 驗簽 + 派遣）
│   ├─ line/gemini.js       Gemini 呼叫封裝
│   ├─ line/actions.js      各意圖處理（開始/進度/催促/結單）
│   ├─ line/excel.js        Excel 產出 + 上傳
│   └─ admin/members.js     名冊 CRUD（後台 API）
├─ schema.sql               D1 建表 SQL
├─ admin.html               後台 UI（名冊維護、歷史任務）
├─ wrangler.toml            Cloudflare 設定（D1 binding）
└─ README.md
```

## 里程碑
- **M1** 基本通：webhook 收訊 + 管理員白名單 + echo 測試
- **M2** Gemini 意圖：開始 / 進度 / 結單
- **M3** 智慧收集：欄位抽取 + 補問 + 歸一
- **M4** 例外 + OCR：菜單校驗 + 升級裁決
- **M5** 催促 + 結案：Excel 產出 + AI 問候
- **M6** 後台 UI：名冊管理、歷史查詢
- **M7** 泛用驗證：餐點 / 便當 / 手套領取 實測

## 權限模型
| 角色 | 權限 |
|---|---|
| 管理員（userId 白名單） | 開始 / 進度 / 催促 / 裁決 / 結單 |
| 一般成員 | 自由回覆（作為資料來源） |
| 非管理員下指令 | 一律忽略 |

## 設計原則
- **零硬編碼關鍵字**：所有意圖辨識走 Gemini
- **零格式負擔**：成員自然說話即可
- **通用架構**：飲料 / 餐點 / 便當 / 接龍 / 物資 同一套邏輯
- **特殊需求一等公民**：過敏、忌口、加料全部保留

## 部署需求（Secrets）
需由 Admin 於 Cloudflare Pages 設為 environment variable：
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `GEMINI_API_KEY`
- `ADMIN_USER_IDS`（逗號分隔）

D1 binding 名稱：`DB`
