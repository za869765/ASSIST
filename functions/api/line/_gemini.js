// Gemini 2.5 Flash chat helper
// 預設開啟 Google Search grounding，讓模型能回即時/事實型問題（天氣、新聞、匯率...）

const MODEL = 'gemini-2.5-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_INSTRUCTION = `你是「小秘書」，一位親切簡潔的 LINE 個人助理，講繁體中文、台灣用語。
規則：
- 回答盡量簡短，一般不超過 3 段或 5 行，以手機閱讀為優先
- 日期/天氣/新聞/匯率等即時性問題，優先用搜尋結果，並在回覆中自然帶出關鍵數字
- 被問到身份時可說「我是你專屬的小秘書」
- 不要加不必要的開場白（如「當然可以！」「以下是...」）直接給答案
- 不要 markdown 標題或粗體，用純文字與條列「- 」即可`;

// 管理員喚醒指令的意圖分類（中文自然語言 → 結構化 intent）
// 可能 intent：
//   start_task  → 開始統計任務（需回 task_name）
//   progress    → 查目前進度
//   close       → 結單/關閉任務
//   chat        → 一般閒聊或知識性問答
export async function geminiIntent(apiKey, text) {
  if (!apiKey) return { intent: 'chat' };
  const sys = `你是 LINE 小秘書指令分類器。使用者是管理員，已去掉喚醒詞「秘書」。
判斷這句話的 intent，並抽出必要欄位：
- "start_task"：使用者想「開始一個統計任務」。範例：「統計飲料」「開始統計便當」「算一下晚餐」「幫我統計大家要喝什麼」→ task_name 為主題（飲料、便當、晚餐…）
- "progress"：問目前進度/誰填了/現在幾筆。範例：「進度」「目前幾筆」「誰還沒填」
- "close"：結束/結單/關閉/收單。範例：「結單」「關了」「結束統計」「可以送了」
- "chat"：其他（閒聊、知識、笑話、天氣、計算…）

另外回傳 confidence（對 intent 判斷的把握）：
- "high"：非常確定（明確的指令字眼）
- "mid"：語意上接近但有模糊空間
- "low"：不確定（當 chat 處理）

task_name 規則：
- start_task：主題（飲料、便當、晚餐…）
- progress / close：若句中有提到特定主題（例「飲料進度」「便當結單」）也填入 task_name，當作要查/結的對象提示；沒提到就 null
- chat：null

嚴格回傳 JSON，不要多餘文字：
{"intent":"start_task"|"progress"|"close"|"chat","task_name":string|null,"confidence":"high"|"mid"|"low"}`;
  const r = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }] }],
      systemInstruction: { parts: [{ text: sys }] },
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 128,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!r.ok) { console.error('[intent] http', r.status); return { intent: 'chat' }; }
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  try { return JSON.parse(txt); } catch { return { intent: 'chat' }; }
}

// 多個並行任務時：判斷此訊息屬於哪一個任務
// taskNames: string[]（例：["飲料", "便當"]）
// 回傳 { task_name: string|null, confidence: 'high'|'mid'|'low' }
export async function geminiClassifyTask(apiKey, taskNames, text) {
  if (!apiKey || !taskNames?.length) return { task_name: null, confidence: 'low' };
  const sys = `同一群組目前有多個進行中的統計任務：${JSON.stringify(taskNames)}。
判斷這則使用者訊息最可能屬於其中哪一個任務（即便字面上不完全一樣，也要從常識/語意推斷）。
重點：使用者回覆任務時不會特意講任務名，你要從內容推測。

舉例（假設任務有 ["飲料","便當"]）：
- 「紅茶拿鐵微糖少冰」→ 飲料（high）
- 「珍珠奶茶」「冬瓜檸檬」「拿鐵」「美式」→ 飲料（high）
- 「排骨飯」「雞腿飯」「魯肉飯」「排骨便當」「雞腿便當」→ 便當（high）
- 「我要排骨飯 + 珍奶」→ 挑最主要的，或 mid
- 「哈哈」「好喔」「收到」→ null（low，純閒聊）

規則：
- 只要內容看得出是食物/飲料類的訂單訊息，就必須選出最接近的任務，即使用詞和任務名不完全一致
- 只有完全無法連到任何任務（純表情、閒聊、與主題無關）才回 null
- 回傳的 task_name 必須是 ${JSON.stringify(taskNames)} 其中之一，或 null

嚴格 JSON：{"task_name":string|null,"confidence":"high"|"mid"|"low"}`;
  const r = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }] }],
      systemInstruction: { parts: [{ text: sys }] },
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 64,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!r.ok) { console.error('[classify] http', r.status); return { task_name: null, confidence: 'low' }; }
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  try { return JSON.parse(txt); } catch { return { task_name: null, confidence: 'low' }; }
}

// 任務模式下，從使用者訊息抽出結構化欄位
// taskName 為任務主題（例：「飲料」「便當」「晚餐」）
// 回傳 { data: { 品項, 甜度, 冰塊, ... }, note, price, confidence }
export async function geminiExtract(apiKey, taskName, userText, knownData = {}) {
  if (!apiKey) return null;
  const sys = `你是訂單解析助手。任務主題：「${taskName}」。
從使用者訊息抽出結構化 JSON。先前已知資料：${JSON.stringify(knownData)}
動態決定該任務需要的欄位（例：飲料 → 品項、甜度、冰塊、大小；便當 → 品項、葷素、份量）。
只抽有把握的欄位，沒提到就不要編造。合併先前已知 + 這次新抽到的。
預設每人一份，除非使用者主動講數量；「份數/數量」不要列入 missing、不要追問。
能從品項名直接推斷的欄位，就自己填上，不要再追問。例：
- 「排骨飯/雞腿飯/牛肉麵/滷肉飯」→ 葷素=葷
- 「素食便當/全素套餐/素麵/素排」→ 葷素=素（使用者特別加「素」字優先判為素）
- 「珍珠奶茶/紅茶拿鐵/冬瓜茶」→ 品項已明確，不用再問
判斷 missing：對此任務「應該要有」但使用者沒講、也無法從品項推斷的欄位（排除份數/數量）。
follow_up：若 missing 非空，提一句簡短的追問（繁中、口語、一行內），例：「甜度冰塊要什麼？」「葷的還是素的？」；若 missing 為空則 null。

嚴格回傳 JSON：
{"data":{...合併後...},"note":null|string,"price":null|number,"missing":string[],"follow_up":null|string,"confidence":"high"|"mid"|"low"}`;
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
    const errTxt = await r.text().catch(() => '');
    console.error('[gemini extract] http', r.status, errTxt);
    return { _error: `HTTP ${r.status}: ${errTxt.slice(0, 200)}` };
  }
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  const finishReason = j?.candidates?.[0]?.finishReason;
  try { return JSON.parse(txt); } catch (e) {
    console.error('[gemini extract] parse fail', { finishReason, txt: txt?.slice(0, 300) });
    return { _error: `parse fail (finish=${finishReason}): ${(txt || '').slice(0, 150)}` };
  }
}

export async function geminiChat(apiKey, userText) {
  if (!apiKey) return '⚠️ 尚未設定 GEMINI_API_KEY';
  const r = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 1024 },
    }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    console.error('[gemini] http', r.status, err);
    return `⚠️ Gemini 錯誤（${r.status}）\n${err.slice(0, 300)}`;
  }
  const j = await r.json();
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();
  return text || '（沒有回應）';
}
