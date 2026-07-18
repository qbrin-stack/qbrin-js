// Type definitions for the qbrin JS SDK. The server is the source of truth;
// these are thin, forward-compatible views (unknown fields pass through).

export declare const DEFAULT_BASE_URL: string;
export declare const VERSION: string;

export declare const DECISION: Readonly<{
  VERIFIED: "verified";
  REJECTED: "rejected";
  NEED_MORE_EVIDENCE: "need_more_evidence";
}>;

export type Decision = "verified" | "rejected" | "need_more_evidence";

/** One cited source excerpt backing a verified answer. */
export interface Evidence {
  n?: number;
  documentId?: string;
  source?: string;
  title?: string;
  snippet?: string;
  score?: number;
  authorEmail?: string | null;
  occurredAt?: string | null;
  [key: string]: unknown;
}

/** The verifier's per-claim audit of a verified answer. */
export interface ClaimVerdict {
  claim: string;
  citations: string[];
  supported: boolean;
  reason?: string | null;
}

/** When the evidence was authored, and whether any of it was queried live. */
export interface Freshness {
  checkedAt: string;
  liveEvidenceCount: number;
  oldestEvidence: string | null;
  newestEvidence: string | null;
}

/** The tri-state verification contract from POST /api/verify. */
export interface VerifyResult {
  decision: Decision;
  reason?: string;
  explanation?: string;
  answer: string | null;
  evidence: Evidence[];
  claims: ClaimVerdict[] | null;
  freshness: Freshness | null;
  trust?: Record<string, unknown> | null;
  route?: { intent?: string; path?: string } | null;
  model?: string | null;
  usage?: Record<string, unknown> | null;
  timings?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** A grounded answer from POST /api/ask — every claim carries a citation. */
export interface AskResult {
  answer: string;
  citations: Evidence[];
  coveredBySnapshot?: boolean;
  [key: string]: unknown;
}

export declare class QbrinError extends Error {}
export declare class TransportError extends QbrinError {}
export declare class APIError extends QbrinError {
  status: number;
  apiMessage: string;
  body: Record<string, unknown>;
}
export declare class AuthenticationError extends APIError {}
export declare class RateLimitError extends APIError {
  retryAfter: number | null;
}
export declare class FeatureDisabledError extends APIError {}

export interface QbrinOptions {
  /** Omit to resolve from QBRIN_API_KEY, then ~/.qbrin/credentials (`qbrin login`). */
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

/** Path to the credentials file `qbrin login` writes (override dir with QBRIN_HOME). */
export declare function credentialsPath(): string;
/** Read ~/.qbrin/credentials, or {} if absent/unreadable. */
export declare function loadStoredCredentials(): Record<string, unknown>;

export declare class Qbrin {
  constructor(opts: QbrinOptions);
  verify(question: string, opts?: { k?: number }): Promise<VerifyResult>;
  ask(question: string, opts?: { k?: number }): Promise<AskResult>;
  search(query: string, opts?: { limit?: number }): Promise<Record<string, unknown>>;
}
