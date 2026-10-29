# Unlimited OCR 2 Workbench v0.2

Human-in-the-loop UI for PDF/image parsing. The default production adapter is Baidu Cloud's asynchronous Unlimited-OCR 2 document parser; local OpenAI-compatible mode and Demo mode remain available.

## Start with Baidu Cloud

```powershell
cd "C:\Users\David Wong\Documents\Codex\2026-10-29\unlimited-ocr-2-ocr-2-https\outputs\unlimited-ocr2-workbench"
$env:BAIDU_API_KEY="your-api-key"
$env:BAIDU_SECRET_KEY="your-secret-key"
node .\server.mjs
```

Open http://localhost:8787. Baidu mode submits the original PDF/image, polls the asynchronous task, then downloads the JSON result. Full onboarding is in [MODEL_SETUP.md](./MODEL_SETUP.md).

## Supported providers

- `BAIDU_API_KEY` + `BAIDU_SECRET_KEY`: Baidu Cloud Unlimited-OCR 2.
- `UNLIMITED_OCR_ENDPOINT`: local OpenAI-compatible server.
- Neither: Demo mode for UI testing.

The feedback file is appended to `feedback/dataset.jsonl`; it is a dataset artifact, not silent online training.
