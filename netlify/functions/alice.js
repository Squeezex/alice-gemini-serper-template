import app from "../../api/index.js";

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function handler(event) {
  let statusCode = 200;
  let payload = {};

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return value;
    },
    setHeader() {}
  };

  await app({
    method: event.httpMethod || "GET",
    body: parseBody(event)
  }, res);

  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  };
}
