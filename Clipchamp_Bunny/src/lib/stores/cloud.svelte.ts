import type { ProviderId, ProviderState, ProviderStatus } from '../types';
import { daemonHealth, isTauri } from '../ipc';

/**
 * Cloud + AI provider state.
 *
 * ⚠ BACKEND SEAM — the backend agent wires the real transports here:
 *   telegram → Go `t9cloud` POST /v1/vault/authorise (QR) + /v1/vault/upload
 *   gemini   → t9cloud /v1/transcribe + /v1/analyze  (fumble detection)
 *   groq     → t9cloud /v1/transcribe                (Whisper Large v3)
 *   local    → Rust ffprobe/ffmpeg on the local disk
 * Nothing else in the UI should talk to the network.
 */
class CloudStore {
  providers = $state<ProviderState[]>([
    {
      id: 'telegram',
      label: 'Telegram Cloud',
      detail: 'QR scanner · MTProto · 1.9 GB split',
      status: 'disconnected'
    },
    {
      id: 'gemini',
      label: 'Gemini API',
      detail: 'Fumble + galat-example detection',
      status: 'disconnected'
    },
    {
      id: 'groq',
      label: 'Groq API',
      detail: 'Whisper Large v3 transcription',
      status: 'disconnected'
    },
    {
      id: 'local',
      label: 'Local disk',
      detail: 'FFmpeg child processes · SQLite',
      status: 'connected'
    }
  ]);

  /** Last provider the user acted on — the UI shows a toast against it. */
  lastAction = $state<{ id: ProviderId; text: string } | null>(null);

  /** True when the daemon answered at least once. */
  daemonUp = $state(false);

  get = (id: ProviderId) => this.providers.find((p) => p.id === id);

  /**
   * Read the daemon's real capabilities and reflect them in the UI.
   *
   * The daemon reports `"ready"` per provider, or the reason it is not ready
   * (for example "TELEGRAM_API_ID / API_HASH not set"). That string becomes
   * the provider's detail, so the user can see *why* something is off.
   */
  async sync() {
    if (!isTauri()) return;
    let health: Awaited<ReturnType<typeof daemonHealth>> = null;
    try {
      health = await daemonHealth();
    } catch {
      health = null;
    }
    this.daemonUp = health !== null;
    if (!health) {
      this.providers = this.providers.map((p) =>
        p.id === 'local' ? p : { ...p, status: 'disconnected' as ProviderStatus, badge: undefined }
      );
      return;
    }

    const caps = health.cloud ?? {};
    const ready = (key: string) => (caps[key] ?? '').toLowerCase() === 'ready';

    this.providers = this.providers.map((p) => {
      if (p.id === 'local') return p;
      if (p.id === 'groq') {
        return {
          ...p,
          status: (ready('transcribe') ? 'connected' : 'disconnected') as ProviderStatus,
          badge: ready('transcribe') ? 'Whisper Large v3' : undefined,
          detail: ready('transcribe') ? p.detail : (caps.transcribe ?? 'transcription is not ready')
        };
      }
      if (p.id === 'gemini') {
        return {
          ...p,
          status: (ready('analyze') ? 'connected' : 'disconnected') as ProviderStatus,
          badge: ready('analyze') ? 'fumble detection' : undefined,
          detail: ready('analyze') ? p.detail : (caps.analyze ?? 'analysis is not ready')
        };
      }
      // Telegram: the daemon says why it is not ready, e.g. the missing
      // API id and hash.
      return {
        ...p,
        status: (ready('vault') ? 'connected' : 'disconnected') as ProviderStatus,
        badge: ready('vault') ? 'MTProto' : undefined,
        detail: ready('vault') ? p.detail : (caps.vault ?? p.detail)
      };
    });
  }

  /**
   * The user asked to connect a provider.
   *
   * Everything that is already configured is reflected from the daemon's
   * health report; Telegram still needs the QR handshake, which is the one
   * piece of the vault flow that is not wired yet.
   */
  connect(id: ProviderId) {
    if (id === 'telegram') {
      this.lastAction = { id, text: 'Telegram QR sign-in is not wired yet' };
      return;
    }
    void this.sync();
  }

  disconnect(id: ProviderId) {
    this.providers = this.providers.map((x) =>
      x.id === id ? { ...x, status: 'disconnected', badge: undefined } : x
    );
  }
}

export const cloud = new CloudStore();
