import type { ProviderId, ProviderState, ProviderStatus } from '../types';

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

  get = (id: ProviderId) => this.providers.find((p) => p.id === id);

  /** Mock connect. The backend replaces this with the real handshake. */
  connect(id: ProviderId) {
    const p = this.get(id);
    if (!p || p.status === 'connected') return;
    this.providers = this.providers.map((x) =>
      x.id === id ? { ...x, status: 'pending' as ProviderStatus } : x
    );
    setTimeout(() => {
      this.providers = this.providers.map((x) =>
        x.id === id
          ? {
              ...x,
              status: 'connected' as ProviderStatus,
              badge:
                id === 'telegram'
                  ? '@EngrTarunDilwal'
                  : id === 'groq'
                    ? 'gsk_••••••••'
                    : 'AIza••••••'
            }
          : x
      );
      this.lastAction = { id, text: `${p.label} connected` };
    }, 700);
  }

  disconnect(id: ProviderId) {
    this.providers = this.providers.map((x) =>
      x.id === id ? { ...x, status: 'disconnected', badge: undefined } : x
    );
  }
}

export const cloud = new CloudStore();
