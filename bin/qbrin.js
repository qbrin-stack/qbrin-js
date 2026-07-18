#!/usr/bin/env node
// `qbrin` CLI — zero-copy-paste auth.
//
//   qbrin login     browser → Google → token → ~/.qbrin/credentials
//   qbrin whoami    show the logged-in org + token expiry
//   qbrin logout    revoke the token and remove the file
//
// `login` opens a browser at the qbrin server, which relays a Google sign-in
// and mints a scoped token server-side; the CLI just polls until it's ready.
// No secret, no loopback, nothing pasted.

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { credentialsPath, DEFAULT_BASE_URL } from "../index.js";

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 300_000;
const baseUrl = () => process.env.QBRIN_BASE_URL || DEFAULT_BASE_URL;

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* print-only fallback */ }
}

async function getJson(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function login() {
  const base = baseUrl();
  const cfg = await getJson(`${base}/auth/cli/config`);
  if (cfg.status === 404) throw new Error("qbrin login isn't enabled on this server yet.");

  const session = crypto.randomBytes(32).toString("base64url");
  const start = `${base}/auth/cli/start?session=${encodeURIComponent(session)}`;
  console.log("Opening your browser to sign in with Google…");
  console.log(`If it doesn't open, visit:\n  ${start}\n`);
  openBrowser(start);

  const poll = `${base}/auth/cli/poll?session=${encodeURIComponent(session)}`;
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let r;
    try { r = (await getJson(poll)).body; } catch { continue; } // transient
    if (r.status === "complete") {
      const path = credentialsPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify({ token: r.token, tokenId: r.tokenId, base_url: base, org: r.org, expiresAt: r.expiresAt }, null, 2));
      chmodSync(path, 0o600);
      console.log(`✓ Signed in to ${r.org?.slug || "your workspace"}. Token saved to ${path}.`);
      console.log("  Now `new Qbrin()` works with no apiKey.");
      return 0;
    }
    if (r.status === "error") throw new Error(r.error || "sign-in failed");
    if (r.status === "expired") throw new Error("sign-in session expired — run `qbrin login` again.");
    // pending → keep polling
  }
  throw new Error("timed out waiting for sign-in");
}

function readCreds() {
  try { return JSON.parse(readFileSync(credentialsPath(), "utf8")); } catch { return null; }
}

function whoami() {
  const c = readCreds();
  if (!c) { console.log("Not logged in. Run `qbrin login`."); return 1; }
  console.log(`org:      ${c.org?.slug || "?"}`);
  console.log(`expires:  ${c.expiresAt || "never"}`);
  console.log(`base_url: ${c.base_url || DEFAULT_BASE_URL}`);
  return 0;
}

async function logout() {
  const c = readCreds();
  if (!c) { console.log("Already logged out."); return 0; }
  if (c.tokenId && c.token) {
    try {
      await fetch(`${c.base_url || DEFAULT_BASE_URL}/auth/tokens/${c.tokenId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${c.token}` },
      });
    } catch { /* best-effort revoke */ }
  }
  try { rmSync(credentialsPath()); } catch { /* already gone */ }
  console.log("Logged out.");
  return 0;
}

const HELP = `qbrin — the Universal Trust Layer

Usage:
  qbrin login    sign in with Google
  qbrin whoami   show the current login
  qbrin logout   revoke and forget the token`;

async function main() {
  const cmd = process.argv[2] || "help";
  try {
    if (cmd === "login") return await login();
    if (cmd === "whoami") return whoami();
    if (cmd === "logout") return await logout();
    console.log(HELP);
    return ["help", "-h", "--help"].includes(cmd) ? 0 : 1;
  } catch (e) {
    console.error(`qbrin: ${e.message}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
