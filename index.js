// qbrin — Building the Universal Trust Layer.
//
// Retrieval tells the AI what it found. Qbrin decides whether it is safe
// enough to use.
//
// Zero-dependency client (Node >= 18, built-in fetch) for the qbrin
// verification layer:
//
//   import { Qbrin } from "qbrin";
//   const qb = new Qbrin({ apiKey: "qbrin_..." });
//   const v = await qb.verify("Can I refund $500 for order ORD-200?");
//   if (v.decision === "verified") act(v.answer, v.evidence);
//
// Auth is a Bearer API token (Console → Settings → API tokens). `fetch` is
// injectable for tests.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://app.qbrin.com/api";
export const VERSION = "0.1.0";

/** Where `qbrin login` stores the token (override the dir with QBRIN_HOME). */
export function credentialsPath() {
  const home = globalThis.process?.env?.QBRIN_HOME || join(homedir(), ".qbrin");
  return join(home, "credentials");
}

/** Read ~/.qbrin/credentials if present; never throws on a missing/bad file. */
export function loadStoredCredentials() {
  try {
    return JSON.parse(readFileSync(credentialsPath(), "utf8"));
  } catch {
    return {};
  }
}

/** The three verification decisions. `verified` is the only one that carries an answer. */
export const DECISION = Object.freeze({
  VERIFIED: "verified",
  REJECTED: "rejected",
  NEED_MORE_EVIDENCE: "need_more_evidence",
});

const RETRYABLE = new Set([429, 502, 503, 504]);

export class QbrinError extends Error {}

/** The request never produced an HTTP response (network/DNS/timeout). */
export class TransportError extends QbrinError {}

/** The API answered with a non-2xx status. */
export class APIError extends QbrinError {
  constructor(status, message, body = {}) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
    this.apiMessage = message;
    this.body = body;
  }
}

/** 401/403 — the API key is missing, invalid, or lacks the needed scope. */
export class AuthenticationError extends APIError {}

/** 429 — slow down; `retryAfter` carries the server's hint in seconds. */
export class RateLimitError extends APIError {
  constructor(status, message, body, retryAfter = null) {
    super(status, message, body);
    this.retryAfter = retryAfter;
  }
}

/** 404 on a known endpoint — the server hasn't enabled it (VERIFY_API=1). */
export class FeatureDisabledError extends APIError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Qbrin {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey        Bearer API token ("qbrin_...")
   * @param {string} [opts.baseUrl]     defaults to the hosted API
   * @param {number} [opts.timeoutMs]   per-request timeout (default 60s)
   * @param {number} [opts.maxRetries]  retries on 429/502/503/504 (default 2)
   * @param {typeof fetch} [opts.fetch] injectable for tests
   */
  constructor({ apiKey, baseUrl, timeoutMs = 60_000, maxRetries = 2, fetch: fetchImpl } = {}) {
    // Credential resolution: explicit arg → QBRIN_API_KEY env → the file
    // `qbrin login` writes (~/.qbrin/credentials). base_url follows the same order.
    const stored = loadStoredCredentials();
    apiKey = apiKey || globalThis.process?.env?.QBRIN_API_KEY || stored.token;
    baseUrl = baseUrl || globalThis.process?.env?.QBRIN_BASE_URL || stored.base_url || DEFAULT_BASE_URL;
    if (!apiKey || typeof apiKey !== "string") {
      throw new QbrinError("No API key found. Run `qbrin login`, set QBRIN_API_KEY, or pass apiKey.");
    }
    const lower = String(baseUrl).toLowerCase();
    if (!lower.startsWith("https://") && !lower.includes("localhost") && !lower.includes("127.0.0.1")) {
      throw new QbrinError("baseUrl must use https (plain http is allowed only for localhost).");
    }
    this._apiKey = apiKey;
    this._baseUrl = baseUrl.replace(/\/+$/, "");
    this._timeoutMs = timeoutMs;
    this._maxRetries = Math.max(0, maxRetries | 0);
    this._fetch = fetchImpl || globalThis.fetch;
  }

  /**
   * Verify a question against the org's connected sources.
   *
   * Returns the tri-state contract: `verified` (with an answer whose every
   * claim passed the citation-support gate, plus per-claim verdicts),
   * `rejected` (the sources contradict the premise), or `need_more_evidence`.
   * `freshness` reports evidence vintage and whether live query-in-place rows
   * were used. Requires VERIFY_API=1 on the server (beta).
   *
   * @param {string} question
   * @param {{ k?: number }} [opts]
   * @returns {Promise<import("./index.d.ts").VerifyResult>}
   */
  async verify(question, opts = {}) {
    const body = { question };
    if (opts.k != null) body.k = opts.k | 0;
    return this._request("POST", "/verify", body);
  }

  /**
   * Ask a question; returns a grounded, citation-first answer. qbrin abstains
   * (a fixed sentence) instead of guessing when the sources lack the answer.
   *
   * @param {string} question
   * @param {{ k?: number }} [opts]
   * @returns {Promise<import("./index.d.ts").AskResult>}
   */
  async ask(question, opts = {}) {
    const body = { question };
    if (opts.k != null) body.k = opts.k | 0;
    return this._request("POST", "/ask", body);
  }

  /**
   * Universal search (no LLM): documents, knowledge nodes, people.
   * @param {string} query
   * @param {{ limit?: number }} [opts]
   */
  async search(query, opts = {}) {
    const params = new URLSearchParams({ q: query });
    if (opts.limit != null) params.set("limit", String(opts.limit | 0));
    return this._request("GET", `/search?${params}`);
  }

  // ── plumbing ──────────────────────────────────────────────────────

  async _request(method, path, body) {
    const url = this._baseUrl + path;
    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      Accept: "application/json",
      "User-Agent": `qbrin-js/${VERSION}`,
    };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this._fetch(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this._timeoutMs),
        });
      } catch (err) {
        throw new TransportError(String(err?.message || err));
      }
      if (RETRYABLE.has(res.status) && attempt < this._maxRetries) {
        await sleep(retryDelayMs(res.headers, attempt + 1));
        continue;
      }
      return parseResponse(res, path);
    }
  }
}

function retryDelayMs(headers, attempt) {
  const ra = headerGet(headers, "retry-after");
  if (ra != null) {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.min(30_000, Math.max(0, s * 1000));
  }
  return Math.min(8000, 500 * 2 ** attempt);
}

function headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? null;
}

async function parseResponse(res, path) {
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (res.status >= 200 && res.status < 300) return data;
  const message = String(data?.error || data?.message || "request failed");
  if (res.status === 401 || res.status === 403) throw new AuthenticationError(res.status, message, data);
  if (res.status === 429) {
    const ra = Number(headerGet(res.headers, "retry-after"));
    throw new RateLimitError(res.status, message, data, Number.isFinite(ra) ? ra : null);
  }
  if (res.status === 404 && path.startsWith("/verify")) {
    throw new FeatureDisabledError(res.status, "The verification endpoint is not enabled on this server (VERIFY_API=1 required).", data);
  }
  throw new APIError(res.status, message, data);
}
