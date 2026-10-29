# Unlimited OCR 2 模型服務與百度雲 API 指引

本版本建議優先使用方案 C：百度智能雲的 Unlimited-OCR 2 文件解析 API。它是託管服務，不需要在公司電腦下載模型或準備 NVIDIA GPU；API 以非同步 task 運作：提交文件、取得 `task_id`、輪詢狀態、下載 JSON 結果。

官方文件：[文檔解析（Unlimited-OCR）](https://ai.baidu.com/ai-doc/OCR/fmr1p39gb)。官方列明提交端點為 `https://aip.baidubce.com/rest/2.0/brain/online/v2/unlimited-ocr-parser/task`，結果端點為同一路徑的 `/task/query`。

## 方案 C：百度雲 API（推薦）

### 1. 開通服務

1. 登入百度智能雲並完成實名認證。
2. 開通「文字識別 → 文檔解析（Unlimited-OCR）」。
3. 建立應用，取得 API Key 與 Secret Key。
4. 確認帳戶有測試額度或已開通計費。

百度官方文件目前說明此服務支援 PDF、圖片等文件，採異步任務；提交 QPS 為 2、查詢 QPS 為 5。實際頁數、大小、額度與價格以官方控制台為準。

### 2. 啟動 Workbench

PowerShell：

```powershell
cd "C:\Users\David Wong\Documents\Codex\2026-10-29\unlimited-ocr-2-ocr-2-https\outputs\unlimited-ocr2-workbench"
$env:BAIDU_API_KEY="你的 API Key"
$env:BAIDU_SECRET_KEY="你的 Secret Key"
$env:BAIDU_BASE_URL="https://aip.baidubce.com"
$env:BAIDU_POLL_MS="5000"
$env:BAIDU_TIMEOUT_MS="900000"
node .\server.mjs
```

開啟 `http://localhost:8787`。密鑰只在 Node backend，瀏覽器不會取得 Secret Key；不要把它寫入 HTML、JavaScript 或 Git。

### 3. 已實作的 API 流程

`server.mjs` 已完整實作：

1. 呼叫 `/oauth/2.0/token`，以 API Key / Secret Key 取得 access token。
2. POST `/unlimited-ocr-parser/task`，以 `application/x-www-form-urlencoded` 傳 `file_data`、`file_name`。
3. 每 5 秒 POST `/unlimited-ocr-parser/task/query` 傳 `task_id`。
4. `pending/running` 繼續等待，`failed` 顯示 `task_error`，`success` 下載 `parse_result_url`。
5. 將百度 `pages[].layouts`、`tables`、`text`、`position` 轉成 UI 的 `layers`、`raw_text`、`bbox`。

連線檢查：`http://localhost:8787/api/health` 應回傳 `provider: "baidu-cloud"` 與 `endpoint_configured: true`。

### 4. 與同事表單 JSON 的關係

百度 API 原生輸出是通用文件解析 JSON，包含版面、表格、標題層級與座標，不會自動知道 ESR 表單欄位。第一版會完整保留百度頁面 layer；Template JSON 是語義參考。

若要輸出同事原有 `response-example.json`，下一階段要加入 schema mapping：把百度的 `layouts/text/tables` 映射到既有 `form.json` 欄位，再做 checkbox、分數與人工修正驗證。這樣可避免把通用 OCR layer 與業務表單 schema 混在一起。

### 5. 常見錯誤

- `282006`：檢查密鑰、服務開通與實名狀態。
- `282005`：額度不足。
- `282003`：缺少 `file_name` / `file_data` 或參數錯誤。
- `282120`：Base64 格式錯誤。
- `282121` / `282122`：請求體過大；官方要求改用 `file_url` 時，第一版尚未加入 BOS/URL 上傳流程。
- `status=failed`：查看 `task_error`，不要只看 HTTP 200。
- token 過期：backend 會快取 token，接近過期時重新取得。

## 方案 A：本地 SGLang（可選）

若文件不能離開公司網路，可依百度官方 repo 自建模型服務：[baidu/Unlimited-OCR](https://github.com/baidu/Unlimited-OCR)。啟動後設定：

```powershell
$env:UNLIMITED_OCR_ENDPOINT="http://127.0.0.1:10000/v1/chat/completions"
$env:UNLIMITED_OCR_MODEL="Unlimited-OCR-2"
```

這個模式需要 Linux/WSL2、CUDA、GPU 與模型權重；百度雲方案則不需要本地 GPU。
