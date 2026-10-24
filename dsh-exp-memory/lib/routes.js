// lib/routes.js —— HTTP 路由（供设置面板/外部工具核对与写设置）：/exp-memory/*
import { readText, writeAtomic, slash, readShards, slugOf } from "./store.js";

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/**
 * @param {object} api { settings(), patchSettings(p), listTargets(), readTarget(target,file), diagnostics() }
 */
export function makeHandler(api) {
  return async function handleRoute(req, res) {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const method = req.method ?? "GET";
      const seg = url.pathname.replace(/^\/exp-memory/, "") || "/";

      if (seg === "/" || seg === "/diagnostics") return sendJson(res, 200, { ok: true, ...api.diagnostics() });

      if (seg === "/settings") {
        if (method === "GET") return sendJson(res, 200, { ok: true, value: api.settings(), targets: api.listTargets() });
        if (method !== "POST") return sendJson(res, 405, { ok: false, error: "use POST" });
        if (req.headers["x-exp-memory"] !== "1") return sendJson(res, 403, { ok: false, error: "missing x-exp-memory header" });
        let patch = {};
        try {
          patch = JSON.parse((await readBody(req)) || "{}")?.patch ?? {};
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
        if (patch === null || typeof patch !== "object") return sendJson(res, 400, { ok: false, error: "patch must be an object" });
        return sendJson(res, 200, { ok: true, value: api.patchSettings(patch) });
      }

      if (seg === "/content") {
        const target = url.searchParams.get("target") ?? "global";
        const file = url.searchParams.get("file") ?? "";
        const result = api.readTarget(target, file);
        if (!result.ok) return sendJson(res, 400, result);
        if (url.searchParams.get("format") === "text") return sendText(res, 200, result.text);
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

export { readText, writeAtomic, slash, readShards, slugOf };
