// Gate an agent's action on a qbrin verification.
// Run:  QBRIN_API_KEY=qbrin_... node examples/verify-agent-action.mjs
import { Qbrin } from "../index.js";

const qb = new Qbrin({ apiKey: process.env.QBRIN_API_KEY });

// The agent wants to refund $500. Verify against the org's own policy + order data.
const v = await qb.verify("Can a support_manager refund $500 for order ORD-7719?");

console.log("decision:   ", v.decision);
console.log("explanation:", v.explanation);

if (v.decision === "verified") {
  console.log("answer:     ", v.answer);
  for (const e of v.evidence) console.log(`  [${e.n}] ${e.source} · ${e.title ?? e.documentId}`);
  // → safe to proceed with the action, with sources logged.
} else if (v.decision === "rejected") {
  console.log("The sources contradict this — do NOT act.");
} else {
  console.log("Not enough evidence — ask for context or connect the missing source.");
}
