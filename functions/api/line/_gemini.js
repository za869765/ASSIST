// Gemini 2.5 Flash chat helper
// 預設開啟 Google Search grounding，讓模型能回即時/事實型問題（天氣、新聞、匯率...）

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_INSTRUCTION = `你是「小秘書」，一位親切簡潔的 LINE 個人助理，講繁體中文、台灣用語。
規則：
- 回答盡量簡短，一般不超過 3 段或 5 行，以手機閱讀為優先
- 日期/天氣/新聞/匯率等即時性問題，優先用搜尋結果，並在回覆中自然帶出關鍵數字
- 被問到身份時可說「我是你專屬的小秘書」
- 不要加不必要的開場白（如「當然可以！」「以下是...」）直接給答案
- 不要 markdown 標題或粗體，用純文字與條列「- 」即可`;

// 任務模式下，從使用者訊息抽出結構化欄位
// taskName 為任務主題（例：「飲料」「便當」「晚餐」）
// 回傳 { data: { 品項, 甜度, 冰塊, ... }, note, price, confidence }
export async function geminiExtract(apiKey, taskName, userText) {
  if (!apiKey) return null;
  const sys = `你是訂單解析助手。任務主題：「${taskName}」。
從下列使用者訊息抽出結構化 JSON，鍵名用繁中（如 品項、甜度、冰塊、葷素、大小、備註、價格）。
規則：
- 只抽有把握的欄位，沒提到就不要編造
- 價格抽成整數存 price
- 特殊需求（不要香菜、過敏）放 note
- confidence: "high" | "mid" | "low"
嚴格回傳 JSON，不要多餘文字：
{"data": {...}, "note": null|string, "price": null|number, "confidence": "high"|"mid"|"low"}`;
  const r = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: sys }] },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!r.ok) {
    console.error('[gemini extract] http', r.status, await r.text().catch(() => ''));
    return null;
  }
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  try { return JSON.parse(txt); } catch { return null; }
}

export async function geminiChat(apiKey, userText) {
  if (!apiKey) return '⚠️ 尚未設定 GEMINI_API_KEY';
  const r = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 1024 },
    }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    console.error('[gemini] http', r.status, err);
    return `⚠️ Gemini 錯誤（${r.status}）`;
  }
  const j = await r.json();
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();
  return text || '（沒有回應）';
}
