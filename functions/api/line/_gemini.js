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
  const hasKnown = knownData && Object.keys(knownData).length > 0;
  const sys = `你是訂單解析助手。任務主題：「${taskName}」。
從使用者訊息抽出結構化 JSON。先前已知資料：${JSON.stringify(knownData)}
動態決定該任務需要的欄位（例：飲料 → 品項、甜度、冰塊、大小；便當 → 品項、葷素、份量）。
只抽有把握的欄位，沒提到就不要編造。

台灣常見品項知識庫（辨識用，不要強套）：
- 茶類：紅茶、綠茶、青茶、烏龍茶、四季春、鐵觀音、普洱、錫蘭紅茶、阿薩姆紅茶、蜜香紅茶、文山包種
- 奶茶系：珍珠奶茶、波霸奶茶、紅茶拿鐵、奶綠、烏龍奶茶、鐵觀音拿鐵、黑糖珍奶、布丁奶茶、椰果奶茶、仙草奶茶、阿薩姆奶茶
- 鮮奶系：鐵觀音鮮奶、紅茶鮮奶、青茶鮮奶、冬瓜鮮奶、黑糖鮮奶、抹茶拿鐵、可可拿鐵
- 水果茶/特調：多多綠、多多檸檬、百香果綠、金桔檸檬、冬瓜檸檬、檸檬紅茶、水蜜桃冰茶、芒果冰茶、葡萄柚綠茶
- 冬瓜系：冬瓜茶、冬瓜青茶（冬青）、冬瓜檸檬（冬檸）、冬瓜鮮奶（冬鮮）
- 咖啡：美式、拿鐵、卡布奇諾、摩卡、焦糖瑪奇朵、冰美式
- 甜度常見值：無糖、微糖（約 30%）、半糖（50%）、少糖（70%）、全糖、正常糖、三分糖、七分糖
- 冰塊常見值：去冰、微冰、少冰、正常冰、多冰、熱（熱飲就不用冰塊欄位）

- 便當/自助餐：排骨飯、雞腿飯、滷雞腿飯、炸雞腿飯、焢肉飯、魯肉飯、三寶飯、雙拼飯、鱈魚便當、鯖魚便當、蝦排飯、咖哩雞飯、打拋豬飯、宮保雞丁飯、糖醋排骨飯、蔥爆牛肉飯、素食便當、全素套餐、義大利肉醬麵、起司焗飯
- 麵食：牛肉麵、紅燒牛肉麵、清燉牛肉麵、榨菜肉絲麵、陽春麵、餛飩麵、擔仔麵、麻醬麵、炸醬麵、酸辣湯麵、肉燥飯、乾麵
- 便當欄位常見值：葷素（葷/素）、飯量（大/中/小/少飯/加飯）、辣度（不辣/小辣/中辣/大辣）

錯字自動糾正（請積極糾正，訂餐情境以口語＋注音/倉頡同鍵錯字、同音字為主）：
- 輸入法錯字：「機腿飯」→「雞腿飯」、「排骨飲」→「排骨飯」、「拿鉄」→「拿鐵」、「美是」→「美式」、「冬瓜檸樣」→「冬瓜檸檬」
- 同音/近音字（飲料）：「清查/情茶/請茶」→「青茶」、「少兵/少並/少平/少瓶」→「少冰」、「微兵/微並」→「微冰」、「去兵」→「去冰」、「珍豬奶茶」→「珍珠奶茶」、「全冰」若飲料類→「正常冰」
- ⚠️ 不同品項不可混：「青茶」（綠茶類）≠「冬青」或「冬瓜青茶」≠「冬瓜茶」，使用者講什麼就是什麼，不要自作主張改成別的品項。錯字糾正只限「同音/形近」而不是「聽起來像的飲料」
- 同音/近音字（甜度）：「半堂/辦糖」→「半糖」、「微堂」→「微糖」、「無堂/勿糖」→「無糖」
- 簡稱保留（視為正常、不要擅自展開）：珍奶（珍珠奶茶）、綠奶（綠茶奶茶）、紅奶（紅茶奶茶）、烏龍、拿鐵、美式、冰美、冬青（冬瓜青茶）、冬檸（冬瓜檸檬）、冬鮮（冬瓜鮮奶）、四季（四季春）
- 飲料情境下「冬X」幾乎都是「冬瓜X」的簡稱（冬瓜 + 其他元素），例：冬青=冬瓜青茶、冬檸=冬瓜檸檬、冬鮮=冬瓜鮮奶。請照此展開並視為標準品項
- 規則：能用常識判斷是同音錯字就改，不要因為「不是官方寫法」就當不認識而放棄。改完把標準名填入對應欄位
- 只有完全無法對應到合理品項時才不改
預設每人一份（一杯/一個/一碗…），除非使用者主動講數量；「份數/杯數/數量」一律不列入 missing、不追問。
使用者訊息中任何修飾詞都視為該欄位的答案，抽進對應欄位或備註，不要再追問同一件事。例：
- 「排骨飯 少飯」→ 品項=排骨飯、飯量=少（或備註=少飯），不追問份量
- 「排骨飯 不要辣」→ 品項=排骨飯、備註=不要辣
- 「珍奶 去冰」→ 品項=珍奶、冰塊=去冰
能從品項名直接推斷的欄位，就自己填上，不要再追問。例：
- 「排骨飯/雞腿飯/牛肉麵/滷肉飯」→ 葷素=葷
- 「素食便當/全素套餐/素麵/素排」→ 葷素=素（使用者特別加「素」字優先判為素）
- 「珍珠奶茶/紅茶拿鐵/冬瓜茶」→ 品項已明確，不用再問
判斷 missing：對此任務「應該要有」但使用者沒講、也無法從品項推斷的欄位（排除份數/杯數/數量）。
follow_up：若 missing 非空，提一句簡短的追問（繁中、口語、一行內），例：「甜度冰塊要什麼？」「葷的還是素的？」；若 missing 為空則 null。
⚠️ 特殊規則：如果你最終 data 是空的（連品項都抽不出來），follow_up 絕對不能是 null，必須給一句口語追問（例：「沒聽懂耶，你要點什麼？」「這個是飲料名嗎？再講一次～」），讓使用者知道你在但沒理解。

若使用者訊息自相矛盾或明顯惡搞（例：「排骨飯不加排骨」「珍奶不要奶」「素食便當加牛肉」），設 nonsense=true、data={}、follow_up 用口語吐槽一句請他認真講，例：「別鬧啦，正經點！」「認真講啦～要什麼？」

${hasKnown ? `⚠️ 此人先前已有紀錄（見上方 knownData）。判斷這次訊息是：
- "replace"：改單/覆蓋舊的（明確另點新的、沒提「加」字、或口氣像改主意）例：先說「排骨飯」後說「改雞腿飯」/「不要了我要雞腿飯」
- "add"：加點（明確提到「加」「再來」「多點」「還要」等累加字眼）例：「再加一杯綠茶」「多點一份排骨飯」
- "unclear"：看不出來是改單還是加點（機率低於 60%）
回傳 dup_intent + dup_confidence（0~100 整數，對此判斷的把握）。

⚠️ 取消訂單偵測（cancel）：若本次訊息只是要「取消/不要/刪除」先前的點餐、沒再點新的（例：「原本那個不要了」「取消我的」「我不吃了」「剛剛那個先不要」），設 cancel=true，data 可為空。有新點的（例：「那個不要，改點 X」）不算 cancel，走 replace。` : 'dup_intent 固定為 null、dup_confidence 為 null、cancel 固定為 false。'}

嚴格回傳 JSON：
{"data":{...僅本次抽到的欄位，不要自行合併舊資料...},"note":null|string,"price":null|number,"missing":string[],"follow_up":null|string,"confidence":"high"|"mid"|"low","nonsense":boolean,"dup_intent":"replace"|"add"|"unclear"|null,"dup_confidence":number|null,"cancel":boolean}`;
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
