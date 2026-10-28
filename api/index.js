const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GROK_MODEL = "grok-4.7";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4400;
const SERPER_TIMEOUT_MS = 400;
const GEMINI_TIMEOUT_MS = 3900;
const PRIMARY_AI_TIMEOUT_MS = 2200;
const GROK_FALLBACK_TIMEOUT_MS = 1800;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    const providerError = data?.error?.message || data?.error || "unknown error";
    console.error("Gemini request failed with HTTP", status, String(providerError).slice(0, 500));
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

async function askGrok(text, history, searchContext, timeoutMs) {
  const key = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  if (!key) throw new Error("MISSING_GROK_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GROK_MODEL || DEFAULT_GROK_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...safeHistory(history).map(item => ({ role: item.role, content: item.text }))
  ];
  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  messages.push({ role: "user", content: prompt });

  const { response, data } = await fetchJson(
    "https://api.x.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        reasoning_effort: "low",
        max_tokens: 240
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    const providerError = data?.error?.message || data?.error || "unknown error";
    console.error("Grok request failed with HTTP", status, String(providerError).slice(0, 500));
    if (status === 401 || status === 403) throw new Error("GROK_KEY_REJECTED");
    if (status === 429) throw new Error("GROK_QUOTA");
    throw new Error("GROK_REQUEST_FAILED");
  }

  const answer = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!answer) throw new Error("GROK_EMPTY_RESPONSE");
  return answer;
}

async function askModel(text, history, searchContext, timeoutMs) {
  const provider = String(process.env.AI_PROVIDER || "auto").trim().toLowerCase();
  if (provider === "grok") return askGrok(text, history, searchContext, timeoutMs);
  if (provider === "gemini") return askGemini(text, history, searchContext, timeoutMs);
  if (provider !== "auto") throw new Error("INVALID_AI_PROVIDER");

  if (process.env.GEMINI_API_KEY) return askGemini(text, history, searchContext, timeoutMs);
  if (process.env.GROK_API_KEY || process.env.XAI_API_KEY) {
    return askGrok(text, history, searchContext, timeoutMs);
  }
  throw new Error("MISSING_AI_KEY");
}

async function askModelWithFallback(text, history, searchContext, timeoutMs, getRemainingMs = () => timeoutMs) {
  const provider = String(process.env.AI_PROVIDER || "auto").trim().toLowerCase();
  const geminiIsPrimary = provider === "gemini" || (provider === "auto" && process.env.GEMINI_API_KEY);
  const grokKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY;

  try {
    return await askModel(text, history, searchContext, timeoutMs);
  } catch (primaryError) {
    const fallbackTimeout = Math.min(
      GROK_FALLBACK_TIMEOUT_MS,
      timeoutMs - 150,
      getRemainingMs() - 150
    );
    if (!geminiIsPrimary || !grokKey || fallbackTimeout < 300) throw primaryError;

    console.warn("Gemini failed; trying Grok fallback:", primaryError?.message || "unknown error");
    return askGrok(text, history, searchContext, fallbackTimeout);
  }
}

function searchFallback(searchContext) {
  if (!searchContext) return "";
  return fitAliceText(`Нейросети временно недоступны. Вот что удалось найти: ${searchContext}`);
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "MISSING_GROK_KEY":
      return "Сервер пока не настроен. Проверьте переменную GROK_API_KEY или XAI_API_KEY.";
    case "GROK_KEY_REJECTED":
      return "Не удалось подключиться к Grok. Проверьте API-ключ xAI.";
    case "GROK_QUOTA":
      return "Сейчас превышен лимит запросов к Grok. Попробуйте немного позже.";
    case "GROK_EMPTY_RESPONSE":
    case "GROK_REQUEST_FAILED":
      return "Не получилось получить ответ от Grok. Попробуйте ещё раз чуть позже.";
    case "MISSING_AI_KEY":
      return "Сервер пока не настроен. Добавьте GEMINI_API_KEY или GROK_API_KEY.";
    case "INVALID_AI_PROVIDER":
      return "В настройках указан неизвестный AI-провайдер. Используйте gemini, grok или auto.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    const provider = String(process.env.AI_PROVIDER || "auto").trim().toLowerCase();
    const geminiIsPrimary = provider === "gemini" || (provider === "auto" && process.env.GEMINI_API_KEY);
    const hasGrokFallback = geminiIsPrimary && (process.env.GROK_API_KEY || process.env.XAI_API_KEY);
    const primaryTimeout = hasGrokFallback ? PRIMARY_AI_TIMEOUT_MS : GEMINI_TIMEOUT_MS;
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - primaryTimeout - 200)));
    }

    let answer;
    try {
      answer = await askModelWithFallback(
        text,
        oldHistory,
        searchContext,
        Math.max(0, Math.min(primaryTimeout, remainingMs() - 200)),
        remainingMs
      );
    } catch (error) {
      const directSearchAnswer = searchFallback(searchContext);
      if (directSearchAnswer) {
        return res.status(200).json(aliceResponse(directSearchAnswer, false, oldHistory));
      }
      throw error;
    }

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
