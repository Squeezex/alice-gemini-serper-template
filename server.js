import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import handler, { warmupGemini } from "./api/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 80);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function createResAdapter(res) {
  let statusCode = 200;
  const headers = { "Content-Type": "application/json; charset=utf-8" };

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    json(value) {
      const body = JSON.stringify(value);
      res.writeHead(statusCode, {
        ...headers,
        "Content-Length": Buffer.byteLength(body)
      });
      res.end(body);
      return value;
    }
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("PAYLOAD_TOO_LARGE");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function isApiPath(pathname) {
  return pathname === "/api" || pathname === "/api/";
}

async function serveIndex(res) {
  try {
    const html = await readFile(join(__dirname, "public", "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.length
    });
    res.end(html);
  } catch {
    sendJson(res, 200, {
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Use POST /api for Yandex Dialogs."
    });
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (method === "GET" && (pathname === "/" || pathname === "/health")) {
      return serveIndex(res);
    }

    if (!isApiPath(pathname)) {
      return sendJson(res, 404, { error: "Not found. Use /api for the Alice webhook." });
    }

    let body = {};
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      body = await readJsonBody(req);
    }

    await handler({ method, body }, createResAdapter(res));
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") {
      return sendJson(res, 413, { error: "Payload too large" });
    }
    if (error?.code === "INVALID_JSON") {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }
    console.error("Unhandled server error:", error?.message || error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Alice webhook listening on http://${HOST}:${PORT}`);
  console.log(`Webhook URL path: /api`);
  // Warm TLS to Google before the first Alice request (critical on Amvera).
  warmupGemini().catch(error => {
    console.warn("Gemini warmup ignored error:", error?.message || error);
  });
});
