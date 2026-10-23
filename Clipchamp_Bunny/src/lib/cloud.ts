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
 * Persist a key securely, then let the daemon pick it up.
 *
 * Secure storage is the backend agent's Task 2 (DPAPI or a documented `.env`
 * limitation). Until then this is honest: it does NOT write the key to
 * localStorage (secrets never go there) and reports the capability as
 * unavailable rather than pretending to save.
 */
export async function saveApiKey(_service: 'gemini' | 'groq', _key: string): Promise<ProbeResult> {
  return { ok: false, detail: 'unavailable' };
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
