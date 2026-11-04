// New Gemini keys often cannot use 2.5 models — prefer 3.5 Flash-Lite with minimal thinking.
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GROK_MODEL = "grok-4.7";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
// Leave headroom for Alice ↔ Amvera network; Dialogs cut off at ~4500ms total.
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 300;
const GEMINI_TIMEOUT_MS = 3100;
const PRIMARY_AI_TIMEOUT_MS = 1800;
const GROK_FALLBACK_TIMEOUT_MS = 1400;

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

function isAbortError(error) {
  return error?.name === "AbortError"
    || error?.message === "AbortError"
    || /aborted/i.test(String(error?.message || ""));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (isAbortError(error)) {
      const abortError = new Error("AbortError");
      abortError.name = "AbortError";
      throw abortError;
    }
    const networkError = new Error("NETWORK_ERROR");
    networkError.cause = error;
    throw networkError;
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

function geminiThinkingConfig(model) {
  const name = String(model || "").toLowerCase();
  // Gemini 2.5 / older: thinkingBudget=0 turns thinking off.
  if (/\b(2\.5|2\.0|1\.5)\b/.test(name)) {
    return { thinkingBudget: 0 };
  }
  // Gemini 3+/4: cannot fully disable; minimal keeps Alice under 4.5s.
  return { thinkingLevel: "minimal" };
}

function resolveGeminiModels() {
  const preferred = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const fallbacks = [
    preferred,
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite"
  ];
  const unique = [];
  for (const model of fallbacks) {
    if (!model || !/^[A-Za-z0-9._-]+$/.test(model)) continue;
    if (!unique.includes(model)) unique.push(model);
  }
  if (!unique.length) throw new Error("INVALID_MODEL_NAME");
  return unique;
}

function extractGeminiText(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const answer = parts
    .filter(part => !part?.thought)
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();
  return { candidate, answer };
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const models = resolveGeminiModels();
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const started = Date.now();
  const budget = Math.min(GEMINI_TIMEOUT_MS, timeoutMs);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": key
  };

  // maxOutputTokens includes thought tokens on Gemini 3.x — keep headroom for the spoken answer.
  const buildBody = (model, withThinking) => JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 512,
      ...(withThinking ? { thinkingConfig: geminiThinkingConfig(model) } : {})
    }
  });

  let lastError = "GEMINI_REQUEST_FAILED";

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const left = budget - (Date.now() - started);
    if (left < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    try {
      let { response, data } = await fetchJson(
        endpoint,
        { method: "POST", headers, body: buildBody(model, true) },
        left
      );

      if (!response.ok && Number(response.status) === 400) {
        const msg = String(data?.error?.message || "").toLowerCase();
        const retryLeft = budget - (Date.now() - started);
        if (retryLeft >= 250 && (msg.includes("thinking") || msg.includes("invalid"))) {
          console.warn(`Gemini ${model} rejected thinkingConfig; retrying without it`);
          ({ response, data } = await fetchJson(
            endpoint,
            { method: "POST", headers, body: buildBody(model, false) },
            retryLeft
          ));
        }
      }

      console.log(`Gemini ${model} finished in ${Date.now() - started}ms, http=${response.status}`);

      if (!response.ok) {
        const status = Number(response.status);
        const providerError = data?.error?.message || data?.error || "unknown error";
        console.error("Gemini request failed with HTTP", status, String(providerError).slice(0, 500));
        if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
        if (status === 429) throw new Error("GEMINI_QUOTA");
        if (status === 404) {
          lastError = "GEMINI_MODEL_UNAVAILABLE";
          console.warn(`Gemini model unavailable: ${model}`);
          continue;
        }
        lastError = "GEMINI_REQUEST_FAILED";
        if (i < models.length - 1) continue;
        throw new Error(lastError);
      }

      const { candidate, answer } = extractGeminiText(data);
      if (!answer) {
        if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
        console.warn(
          "Gemini empty text. finishReason=",
          candidate?.finishReason,
          "parts=",
          JSON.stringify(candidate?.content?.parts || []).slice(0, 300)
        );
        lastError = "GEMINI_EMPTY_RESPONSE";
        if (i < models.length - 1) continue;
        throw new Error(lastError);
      }
      if (candidate?.finishReason === "MAX_TOKENS") {
        console.warn("Gemini reached the output token limit.");
      }
      return answer;
    } catch (error) {
      if (
        error?.message === "MISSING_GEMINI_KEY"
        || error?.message === "GEMINI_KEY_REJECTED"
        || error?.message === "GEMINI_QUOTA"
        || error?.message === "GEMINI_BLOCKED"
        || error?.message === "TIME_BUDGET_EXHAUSTED"
        || error?.message === "AbortError"
      ) {
        throw error;
      }
      if (error?.message === "NETWORK_ERROR") {
        console.error("Gemini network error:", error?.cause?.message || error);
        throw new Error("GEMINI_NETWORK");
      }
      if (
        error?.message === "GEMINI_MODEL_UNAVAILABLE"
        || error?.message === "GEMINI_EMPTY_RESPONSE"
        || error?.message === "GEMINI_REQUEST_FAILED"
      ) {
        lastError = error.message;
        if (i < models.length - 1) continue;
        throw error;
      }
      throw error;
    }
  }

  throw new Error(lastError);
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

  const requests = [];
  if (process.env.GEMINI_API_KEY) requests.push(askGemini(text, history, searchContext, timeoutMs));
  if (process.env.GROK_API_KEY || process.env.XAI_API_KEY) {
    requests.push(askGrok(text, history, searchContext, timeoutMs));
  }
  if (requests.length === 1) return requests[0];
  if (requests.length > 1) {
    try {
      return await Promise.any(requests);
    } catch (error) {
      throw error?.errors?.[0] || error;
    }
  }
  throw new Error("MISSING_AI_KEY");
}

async function askModelWithFallback(text, history, searchContext, timeoutMs, getRemainingMs = () => timeoutMs) {
  const provider = String(process.env.AI_PROVIDER || "auto").trim().toLowerCase();
  const geminiIsPrimary = provider === "gemini";
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
  const code = isAbortError(error) ? "AbortError" : error?.message;
  switch (code) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в Amvera.";
    case "GEMINI_KEY_REJECTED":
      return "Gemini отклонил API-ключ. Проверьте GEMINI_API_KEY в секретах Amvera.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "GEMINI_MODEL_UNAVAILABLE":
      return "Указанная модель Gemini недоступна для ключа. Поставьте GEMINI_MODEL=gemini-3.5-flash-lite.";
    case "GEMINI_EMPTY_RESPONSE":
      return "Gemini вернул пустой ответ. Попробуйте короче сформулировать вопрос.";
    case "GEMINI_REQUEST_FAILED":
      return "Запрос к Gemini завершился ошибкой. Проверьте логи приложения в Amvera.";
    case "GEMINI_NETWORK":
      return "Сервер не достучался до Gemini API. Проверьте интернет/регион Amvera или ключ.";
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
      return "Сервер пока не настроен. Добавьте GEMINI_API_KEY в секреты Amvera.";
    case "INVALID_AI_PROVIDER":
      return "В настройках указан неизвестный AI-провайдер. Используйте gemini, grok или auto.";
    case "INVALID_MODEL_NAME":
      return "Некорректное имя модели в GEMINI_MODEL.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    case "NETWORK_ERROR":
      return "Сервер не достучался до нейросети. Проверьте сеть Amvera.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api.",
      provider: String(process.env.AI_PROVIDER || "auto"),
      model: String(process.env.GEMINI_MODEL || DEFAULT_MODEL),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasSerperKey: Boolean(process.env.SERPER_API_KEY)
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
      "Что хотите узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    const provider = String(process.env.AI_PROVIDER || "auto").trim().toLowerCase();
    const geminiIsPrimary = provider === "gemini" || (provider === "auto" && process.env.GEMINI_API_KEY);
    const hasGrokFallback = geminiIsPrimary && (process.env.GROK_API_KEY || process.env.XAI_API_KEY);
    const parallelProviders = provider === "auto" && process.env.GEMINI_API_KEY &&
      (process.env.GROK_API_KEY || process.env.XAI_API_KEY);
    const primaryTimeout = parallelProviders
      ? GEMINI_TIMEOUT_MS
      : (hasGrokFallback ? PRIMARY_AI_TIMEOUT_MS : GEMINI_TIMEOUT_MS);
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

    console.log(`Alice webhook ok in ${Date.now() - startedAt}ms`);
    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = isAbortError(error) ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn(
      `Alice webhook fallback in ${Date.now() - startedAt}ms:`,
      safeError?.message || "unknown error",
      error?.cause?.message || ""
    );
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
