/**
 * The user's own pinned websites (the 9-dots panel's `+`).
 *
 * Two surfaces need the same list now: the tools panel, where a site is pinned,
 * and the browser's new-tab shortcuts, where a pinned site is the click that
 * matters. One store means a pin appears in both at the same moment, and the
 * existing localStorage key is kept so nothing the user already pinned is lost.
 */

export interface PinnedTool {
  id: string;
  name: string;
  url: string;
}

const STORE_KEY = 't9-editor-lit.tools';

/** Host part of a URL — used as the default name for a pin. */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** `example.com` → `https://example.com/`; junk returns `''`. */
export function normaliseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    return new URL(url).toString();
  } catch {
    return '';
  }
}

function load(): PinnedTool[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is Partial<PinnedTool> => !!t && typeof t === 'object')
      .filter((t) => typeof t.url === 'string' && t.url.length > 0)
      .map((t) => ({
        id: String(t.id ?? 'u' + Math.random().toString(36).slice(2)),
        name: String(t.name || hostOfUrl(String(t.url))),
        url: String(t.url)
      }));
  } catch {
    return [];
  }
}

class PinnedToolsStore {
  items = $state<PinnedTool[]>(load());

  /** Pin a site. Returns `null` when the URL is not usable. */
  add(rawUrl: string, rawName = ''): PinnedTool | null {
    const url = normaliseUrl(rawUrl);
    if (!url) return null;
    const tool: PinnedTool = {
      id: 'u' + Date.now().toString(36),
      name: rawName.trim() || hostOfUrl(url),
      url
    };
    this.items = [...this.items, tool];
    this.save();
    return tool;
  }

  remove(id: string): void {
    this.items = this.items.filter((t) => t.id !== id);
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.items));
    } catch {
      /* private mode / quota — the pin still works for this session */
    }
  }
}

export const pinnedTools = new PinnedToolsStore();
