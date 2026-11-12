/**
 * T9 Cloud — the single module the UI talks to.
 *
 * This is a **thin service layer with the real API shapes**. The desktop UI is
 * being finalised first (the user's directive: localhost is for dev/inspect,
 * the real backend gets attached once the UI is signed off). So the parts of
 * the T9 Cloud page that already have a live answer on localhost fetch it for
 * real; the parts whose backend does not exist yet return an honest
 * "not available" and the card says so. Nothing here ever reports a service as
 * "connected" because a field is non-empty.
 *
 * The two things that ARE real right now, because the Go daemon already serves
 * them on 127.0.0.1:7878 with CORS `*`:
 *
 *   · `GET /healthz`          → which pipelines are ready (Groq/Gemini/…)
 *   · `GET /v1/vault/status`  → whether Telegram is configured + authorised
 *
 * The provider key tests (`POST /v1/cloud/probe/…`) and secure key storage are
 * the backend agent's work order (`BACKEND.md` Task 1–2). Until those land, the
 * functions below attempt the real endpoint and fall back to an honest failure
 * instead of pretending — so wiring the backend later is a no-op on this file.
 *
 * Every request is on a short timer and never buffers a body into memory: the
 * zero-RAM rule applies to credentials too.
 */

const DAEMON = 'http://127.0.0.1:7878';

/** Short, hard timeout — a loopback call that has not answered in 4 s never will. */
const TIMEOUT_MS = 4000;

/* ------------------------------------------------------------------ types */

/** `Config.Capabilities()` — which pipelines the daemon can actually run. */
export type Capability = 'ready' | string;

export interface QueueHealth {
  depth: number;
  capacity: number;
  workers: number;
  blocked: boolean;
  inFlight: number;
  completed: number;
  failed: number;
}

/** `model.Health` from `GET /healthz`, camelCased. */
export interface CloudHealth {
  ok: boolean;
  version: string;
  uptimeSecs: number;
  queue: QueueHealth;
  cloud: Record<string, Capability>;
}

/** `vault.Status` from `GET /v1/vault/status`, camelCased. */
export interface VaultStatus {
  configured: boolean;
  authorised: boolean;
  account?: string;
  chat?: string;
  connections: number;
  partBytes: number;
  sessionPath: string;
  detail?: string;
}

/** `vault.LoginChallenge` — the QR login state machine. */
export type LoginPhase = 'waiting' | 'authorised' | 'expired' | 'password_needed' | 'failed';

export interface LoginChallenge {
  id: string;
  url?: string;
  expiresUnix?: number;
  phase: LoginPhase;
  detail?: string;
  rotations: number;
  account?: string;
}

/**
 * The result of a key test. `detail` is a STABLE code the UI translates
 * (`ok` · `invalid_key` · `rate_limited` · `network` · `unavailable`) — never
 * provider prose, and never the key.
 */
export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/* --------------------------------------------------------- daemon helpers */

async function withTimeout(input: string, init?: RequestInit): Promise<Response | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: ctl.signal, cache: 'no-store' });
  } catch {
    // Daemon down, browser preview, or aborted — all the same to the caller:
    // "no live answer", not an error to shout about.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const snakeToCamel = <T>(o: Record<string, unknown>): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as T;
};

/**
 * The daemon's health, or `null` when it is not running.
 *
 * Genuinely real: this is what drives the T9 Cloud card and the "n of 4"
 * progress. A `null` means the card shows "offline" — never "connected".
 */
export async function fetchHealth(): Promise<CloudHealth | null> {
  const res = await withTimeout(`${DAEMON}/healthz`);
  if (!res || !res.ok) return null;
  try {
    const raw = (await res.json()) as Record<string, unknown>;
    return snakeToCamel<CloudHealth>({
      ...raw,
      queue: (raw.queue as Record<string, unknown>) ?? {}
    });
  } catch {
    return null;
  }
}

/** Telegram vault status, or `null` when the daemon is not running. */
export async function fetchVaultStatus(): Promise<VaultStatus | null> {
  const res = await withTimeout(`${DAEMON}/v1/vault/status`);
  if (!res || !res.ok) return null;
  try {
    return snakeToCamel<VaultStatus>((await res.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- key probes */

/**
 * Test a Gemini key for real, via the daemon's key probe.
 *
 * `POST /v1/keys/probe` (backend agent's Task 1) lists the account's models —
 * a GET that costs no quota — so a dead key is caught honestly instead of the
 * card claiming "connected" because a field is non-empty. An empty `key` makes
 * the daemon re-verify the credential it was started with. The daemon returns
 * a human sentence in `detail` that is safe to show and never contains the key.
 */
export function probeGemini(key: string): Promise<ProbeResult> {
  return probe('gemini', key);
}

/** Test a Groq key. Same contract as `probeGemini`. */
export function probeGroq(key: string): Promise<ProbeResult> {
  return probe('groq', key);
}

async function probe(service: 'gemini' | 'groq', key: string): Promise<ProbeResult> {
  const res = await withTimeout(`${DAEMON}/v1/keys/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The key travels in the body over loopback and is never persisted here.
    body: JSON.stringify({ service, key })
  });
  // No answer, or the endpoint is not in this build → honest "can't test yet",
  // never a fake success.
  if (!res) return { ok: false, detail: 'unavailable' };
  if (res.status === 404) return { ok: false, detail: 'unavailable' };
  try {
    const body = (await res.json()) as { ok?: boolean; detail?: string };
    // A dead key is still a 200 with ok:false; only a malformed request is an
    // error status, which we surface as "can't test".
    if (!res.ok) return { ok: false, detail: body.detail ?? 'unavailable' };
    return { ok: body.ok === true, detail: body.detail ?? (body.ok ? 'ok' : 'invalid_key') };
  } catch {
    return { ok: false, detail: 'network' };
  }
}

/**
 * Persist a key for real, then let the daemon use it immediately.
 *
 * `PUT /v1/keys/{service}` writes the credential into the daemon's overlay
 * file (`keys.local.env`, never the user's hand-maintained `.env`) and
 * hot-swaps the live client, so the very next transcription or analysis uses
 * it — no restart. The daemon answers with the key **masked**, and this
 * function never stores what the caller typed beyond this one call.
 */
export async function saveApiKey(service: 'gemini' | 'groq', key: string): Promise<ProbeResult> {
  return putKey(service, key);
}

/**
 * Remove a key. The daemon records an explicit empty override, so the key is
 * genuinely gone after a restart instead of coming back from `.env`.
 */
export async function deleteApiKey(service: 'gemini' | 'groq'): Promise<ProbeResult> {
  const res = await withTimeout(`${DAEMON}/v1/keys/${service}`, { method: 'DELETE' });
  if (!res) return { ok: false, detail: 'unavailable' };
  return verdict(res);
}

async function putKey(service: 'gemini' | 'groq', key: string): Promise<ProbeResult> {
  const res = await withTimeout(`${DAEMON}/v1/keys/${service}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key })
  });
  if (!res) return { ok: false, detail: 'unavailable' };
  return verdict(res);
}

/** One place that turns a key endpoint's answer into the card's two outcomes. */
async function verdict(res: Response): Promise<ProbeResult> {
  if (res.status === 404) return { ok: false, detail: 'unavailable' };
  try {
    const body = (await res.json()) as { error?: string; configured?: boolean; masked?: string };
    if (!res.ok) return { ok: false, detail: body.error ?? 'unavailable' };
    return { ok: body.configured === true, detail: body.masked ?? 'ok' };
  } catch {
    return { ok: false, detail: 'network' };
  }
}

/* ------------------------------------------- ElevenLabs account pool */

/**
 * `cloud.KeyStatus` from the pool endpoints, camelCased.
 *
 * The daemon never returns a key — `id` is a stable hash the remove call
 * takes back, `masked` is enough to recognise the account, and `state` is
 * what the scheduler decided: `ready` · `cooldown` · `disabled`.
 */
export interface ElevenKeyStatus {
  id: string;
  masked: string;
  state: 'ready' | 'cooldown' | 'disabled';
  uses: number;
  cooldownSecs?: number;
  lastError?: string;
  /** Quota snapshot from the last probe: "62% of this month used". */
  tier?: string;
  quotaUsed?: number;
  quotaLimit?: number;
}

export interface ElevenKeysResult {
  keys: ElevenKeyStatus[];
  /** The daemon's one-line note on the last action ("key was already..."). */
  note?: string;
}

export type ElevenAction = ({ ok: true } & ElevenKeysResult) | { ok: false; detail: string };

/** Read the whole pool. `null` when the daemon is down or predates the routes. */
export async function fetchElevenKeys(): Promise<ElevenKeysResult | null> {
  const res = await withTimeout(`${DAEMON}/v1/keys/elevenlabs`);
  if (!res || !res.ok) return null;
  try {
    const raw = (await res.json()) as Record<string, unknown>;
    return snakeToCamel<ElevenKeysResult>(raw);
  } catch {
    return null;
  }
}

/**
 * Probe a key and add it to the pool for real in one call.
 *
 * A key the provider rejects gets a 400 with the probe's sentence and changes
 * nothing on disk — a typo can never enter the pool. A good key lands in the
 * overlay and hot-swaps the live client, so the next chunk uses it.
 */
export async function addElevenKey(key: string): Promise<ElevenAction> {
  const res = await withTimeout(`${DAEMON}/v1/keys/elevenlabs/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key })
  });
  return elevenVerdict(res);
}

/** Drop one account by its public id (the hash the list gave the UI). */
export async function removeElevenKey(id: string): Promise<ElevenAction> {
  const res = await withTimeout(`${DAEMON}/v1/keys/elevenlabs/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  return elevenVerdict(res);
}

/** Clear the pool entirely. The overlay records the explicit empty value. */
export async function clearElevenKeys(): Promise<ElevenAction> {
  const res = await withTimeout(`${DAEMON}/v1/keys/elevenlabs`, { method: 'DELETE' });
  return elevenVerdict(res);
}

export interface ElevenImportResult {
  /** Masked keys that joined the pool. */
  added: string[];
  /** Masked keys the provider rejected — partial success is normal. */
  rejected: string[];
  /** How many were already in the pool (their quota snapshot was refreshed). */
  duplicate: number;
  /** The same file's Groq/Gemini keys were saved to their overlays too. */
  groqUpdated: boolean;
  geminiUpdated: boolean;
}

/**
 * Import keys from an .env the user pastes (or points at).
 *
 * Only three variables are read — ELEVENLABS_API_KEYS, GROQ_API_KEY and
 * GEMINI_API_KEY — because a secrets import must never become a general
 * config import. Every candidate ElevenLabs key is probed first; the ones the
 * provider rejects are reported per key and never fail the batch.
 */
export async function importElevenEnv(req: {
  content?: string;
  path?: string;
}): Promise<{ ok: true; result: ElevenImportResult } | { ok: false; detail: string }> {
  const res = await withTimeout(`${DAEMON}/v1/keys/elevenlabs/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The daemon requires at least one of the two; send only what was given.
    body: JSON.stringify({
      ...(req.content ? { content: req.content } : {}),
      ...(req.path ? { path: req.path } : {})
    })
  });
  if (!res) return { ok: false, detail: 'unavailable' };
  if (res.status === 404) return { ok: false, detail: 'unavailable' };
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) return { ok: false, detail: (body.error as string) ?? 'unavailable' };
    return { ok: true, result: snakeToCamel<ElevenImportResult>(body) };
  } catch {
    return { ok: false, detail: 'network' };
  }
}

/** Turn a pool mutation's answer into the panel's two outcomes. */
async function elevenVerdict(res: Response | null): Promise<ElevenAction> {
  if (!res) return { ok: false, detail: 'unavailable' };
  if (res.status === 404) return { ok: false, detail: 'unavailable' };
  try {
    const raw = (await res.json()) as Record<string, unknown>;
    if (!res.ok) return { ok: false, detail: (raw.error as string) ?? 'unavailable' };
    return { ok: true, ...snakeToCamel<ElevenKeysResult>(raw) };
  } catch {
    return { ok: false, detail: 'network' };
  }
}

/* --------------------------------------------------------------- usage */

/** Groq's rate-limit headers, verbatim. Absent fields mean "did not say". */
export interface RateLimit {
  /** Requests per day (that is what Groq's header means). */
  requestsLimit?: number;
  requestsRemaining: number;
  requestsReset?: string;
  /** Tokens per minute. */
  tokensLimit?: number;
  tokensRemaining: number;
  tokensReset?: string;
  /** Only ever present on a 429. */
  retryAfter?: string;
  capturedAt?: string;
}

export interface DayUsage {
  date: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ServiceUsage {
  service: string;
  calls: number;
  errors: number;
  rateLimited: number;
  tokensIn: number;
  tokensOut: number;
  audioSecs: number;
  lastCall?: string;
  lastLatencyMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  lastError?: string;
  lastErrorAt?: string;
  rateLimit?: RateLimit;
  today?: DayUsage;
  /** -1 = the provider publishes no such limit (Gemini, /models calls). */
  requestsUsedPct: number;
  tokensUsedPct: number;
}

export interface CallSummary {
  service: string;
  at: string;
  status: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  err?: string;
}

/** What is configured, as far as the UI may ever know: never the key itself. */
export interface KeyState {
  service: 'gemini' | 'groq' | 'elevenlabs';
  configured: boolean;
  masked?: string;
  model?: string;
  chatModel?: string;
  /** ElevenLabs only: how many accounts the pool holds. */
  count?: number;
}

export interface UsageResponse {
  updatedAt: string;
  services: Record<string, ServiceUsage>;
  recent: CallSummary[];
  keys: KeyState[];
  overlayPath?: string;
  callsPath?: string;
}

/**
 * Everything the rate-limit gauge draws.
 *
 * The three outcomes are kept apart on purpose, because they are three
 * different truths: the daemon answered (`ok`), it answered but this build
 * has no `/v1/usage` route yet (`outdated` — an older t9cloud.exe), or it is
 * not reachable at all (`down`). Collapsing them into one `null` made the UI
 * claim "the daemon is not running" while it was running perfectly well, just
 * without this endpoint.
 */
export type UsageResult =
  { state: 'ok'; usage: UsageResponse } | { state: 'outdated' } | { state: 'down' };

export async function fetchUsageState(): Promise<UsageResult> {
  const res = await withTimeout(`${DAEMON}/v1/usage`);
  if (!res) return { state: 'down' };
  if (res.status === 404) return { state: 'outdated' };
  if (!res.ok) return { state: 'down' };
  try {
    const raw = (await res.json()) as Record<string, unknown>;
    return { state: 'ok', usage: deepCamel<UsageResponse>(raw) };
  } catch {
    return { state: 'down' };
  }
}

/**
 * The daemon replies in snake_case and `snakeToCamel` above only walks one
 * level, so the usage payload — which nests — gets a deep conversion here.
 * Converting at the edge keeps every component free of JSON-shape knowledge.
 */
function deepCamel<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map(deepCamel) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = deepCamel(v);
    }
    return out as T;
  }
  return value as T;
}

/* ----------------------------------------------------------- telegram QR */

/**
 * Begin a QR login.
 *
 * The endpoint is real, but it needs TELEGRAM_API_ID / API_HASH set in the
 * daemon's env — until the backend agent wires credentials it answers 503
 * "not configured", which maps to a `failed` phase with that detail. The UI
 * renders the honest "needs configuration" state; it never draws a decorative
 * QR.
 */
export async function beginTelegramLogin(): Promise<LoginChallenge> {
  const res = await withTimeout(`${DAEMON}/v1/vault/authorise`, { method: 'POST' });
  if (!res) return offline();
  return readChallenge(res);
}

/** Poll a login attempt. The token rotates ~30 s, so the UI re-renders the QR. */
export async function pollTelegramLogin(id: string): Promise<LoginChallenge> {
  const res = await withTimeout(`${DAEMON}/v1/vault/authorise/${encodeURIComponent(id)}`);
  if (!res) return offline();
  return readChallenge(res);
}

function offline(): LoginChallenge {
  return { id: '', phase: 'failed', detail: 'offline', rotations: 0 };
}

async function readChallenge(res: Response): Promise<LoginChallenge> {
  // A non-2xx still carries a useful detail (not-configured, password-needed…).
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return {
        id: '',
        phase: 'failed',
        detail: (body.error as string) ?? 'failed',
        rotations: 0
      };
    }
    return snakeToCamel<LoginChallenge>(body);
  } catch {
    return offline();
  }
}
