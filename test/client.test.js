// Offline SDK tests — a stub fetch, no network. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Qbrin,
  QbrinError,
  AuthenticationError,
  RateLimitError,
  FeatureDisabledError,
  credentialsPath,
  loadStoredCredentials,
} from "../index.js";

const VERIFIED = {
  decision: "verified",
  reason: "gates_passed_verifier_ok",
  explanation: "Every claim is cited and verified.",
  answer: '[21] Order ORD-7719 has a status of "paid" and an amount of 500.',
  evidence: [{ n: 21, documentId: "live:orders", source: "live:postgres", snippet: "orders — id: ORD-7719" }],
  claims: [{ claim: "status is paid", citations: ["21"], supported: true, reason: "stated in [21]" }],
  freshness: { checkedAt: "2026-07-17T16:07:17.893Z", liveEvidenceCount: 1, oldestEvidence: null, newestEvidence: "2026-07-17T16:07:13.280Z" },
  trust: { decision: "allow", level: "verified" },
};

function stubFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const [status, headers, body] = responses.shift();
    return {
      status,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

const make = (responses, opts = {}) => {
  const f = stubFetch(responses);
  return [new Qbrin({ apiKey: "qbrin_test", fetch: f, ...opts }), f];
};

test("verify: parses the tri-state contract with claims + freshness", async () => {
  const [qb, f] = make([[200, {}, VERIFIED]]);
  const v = await qb.verify("What is the status of order ORD-7719?");
  assert.equal(v.decision, "verified");
  assert.equal(v.claims[0].supported, true);
  assert.equal(v.freshness.liveEvidenceCount, 1);
  assert.equal(v.evidence[0].source, "live:postgres");
  const call = f.calls[0];
  assert.ok(call.url.endsWith("/verify"));
  assert.equal(call.init.method, "POST");
  assert.ok(call.init.headers.Authorization.startsWith("Bearer qbrin_"));
});

test("verify: k is passed through the body", async () => {
  const [qb, f] = make([[200, {}, VERIFIED]]);
  await qb.verify("q", { k: 12 });
  assert.equal(JSON.parse(f.calls[0].init.body).k, 12);
});

test("401 → AuthenticationError", async () => {
  const [qb] = make([[401, {}, { error: "bad token" }]]);
  await assert.rejects(() => qb.verify("q"), AuthenticationError);
});

test("404 on /verify → FeatureDisabledError", async () => {
  const [qb] = make([[404, {}, { error: "Not found." }]]);
  await assert.rejects(() => qb.verify("q"), FeatureDisabledError);
});

test("429 retries then surfaces RateLimitError with retryAfter", async () => {
  const [qb, f] = make([
    [429, { "retry-after": "0" }, { error: "rate_limited" }],
    [429, { "retry-after": "0" }, { error: "rate_limited" }],
    [429, { "retry-after": "7" }, { error: "rate_limited" }],
  ]);
  await assert.rejects(
    () => qb.verify("q"),
    (e) => e instanceof RateLimitError && e.retryAfter === 7,
  );
  assert.equal(f.calls.length, 3); // initial + 2 retries (default maxRetries)
});

test("503 then success retries transparently", async () => {
  const [qb, f] = make([
    [503, {}, { error: "warming" }],
    [200, {}, VERIFIED],
  ]);
  const v = await qb.verify("q");
  assert.equal(v.decision, "verified");
  assert.equal(f.calls.length, 2);
});

test("http base URL rejected; localhost allowed", () => {
  assert.throws(() => new Qbrin({ apiKey: "qbrin_x", baseUrl: "http://evil.example.com/api" }), QbrinError);
  new Qbrin({ apiKey: "qbrin_x", baseUrl: "http://localhost:4000/api" });
});

test("apiKey required", () => {
  assert.throws(() => new Qbrin({}), QbrinError);
});

test("ask: returns answer + citations", async () => {
  const [qb] = make([[200, {}, { answer: "[1] Two weeks.", citations: [{ n: 1, documentId: "d9" }], coveredBySnapshot: true }]]);
  const a = await qb.ask("Notice period?");
  assert.equal(a.citations[0].documentId, "d9");
  assert.equal(a.coveredBySnapshot, true);
});

test("search: builds the query string, GET", async () => {
  const [qb, f] = make([[200, {}, { results: [] }]]);
  await qb.search("refund policy", { limit: 5 });
  assert.ok(f.calls[0].url.includes("/search?"));
  assert.ok(f.calls[0].url.includes("limit=5"));
  assert.equal(f.calls[0].init.method, "GET");
});

// ── credential resolution ────────────────────────────────────────────
// QBRIN_HOME overrides the credentials directory entirely (it IS the qbrin home
// containing `credentials`). Cleanup is deferred until an async body settles.
function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qbrin-test-"));
  const saved = { home: process.env.QBRIN_HOME, key: process.env.QBRIN_API_KEY, base: process.env.QBRIN_BASE_URL };
  process.env.QBRIN_HOME = dir;
  delete process.env.QBRIN_API_KEY;
  delete process.env.QBRIN_BASE_URL;
  const cleanup = () => {
    for (const [k, v] of [["QBRIN_HOME", saved.home], ["QBRIN_API_KEY", saved.key], ["QBRIN_BASE_URL", saved.base]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  let result;
  try { result = fn(dir); } catch (e) { cleanup(); throw e; }
  if (result && typeof result.then === "function") return result.finally(cleanup);
  cleanup();
  return result;
}

test("no key anywhere → clear QbrinError mentioning qbrin login", () => {
  withHome(() => {
    assert.throws(() => new Qbrin(), (e) => e instanceof QbrinError && /qbrin login/.test(e.message));
  });
});

test("resolves QBRIN_API_KEY from the environment", () => {
  withHome(() => {
    process.env.QBRIN_API_KEY = "qbrin_from_env";
    const f = stubFetch([[200, {}, VERIFIED]]);
    const qb = new Qbrin({ fetch: f });
    return qb.verify("q").then(() => assert.ok(f.calls[0].init.headers.Authorization.endsWith("qbrin_from_env")));
  });
});

test("resolves the token from the credentials file", () => {
  return withHome((dir) => {
    const p = credentialsPath(); // dir/credentials, since QBRIN_HOME overrides the home
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ token: "qbrin_from_file", base_url: "https://app.qbrin.com/api" }));
    assert.equal(loadStoredCredentials().token, "qbrin_from_file");
    assert.ok(p.endsWith("credentials"));
    const f = stubFetch([[200, {}, VERIFIED]]);
    const qb = new Qbrin({ fetch: f });
    return qb.verify("q").then(() => assert.ok(f.calls[0].init.headers.Authorization.endsWith("qbrin_from_file")));
  });
});

test("explicit apiKey beats env and file", () => {
  return withHome(() => {
    process.env.QBRIN_API_KEY = "qbrin_env";
    const f = stubFetch([[200, {}, VERIFIED]]);
    const qb = new Qbrin({ apiKey: "qbrin_explicit", fetch: f });
    return qb.verify("q").then(() => assert.ok(f.calls[0].init.headers.Authorization.endsWith("qbrin_explicit")));
  });
});
