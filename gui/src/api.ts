/** Talking to the local duo server. The token arrives in the URL fragment and never leaves this window. */
const TOKEN_KEY = 'duo.token';

function readToken(): string {
  const fromHash = location.hash.slice(1);
  if (fromHash) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromHash);
    } catch {
      /* storage blocked: the token still works for this page */
    }
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export const token = readToken();

// A token delivered after load (same URL, new fragment) needs a fresh start.
window.addEventListener('hashchange', () => {
  if (location.hash.length > 1) {
    try {
      sessionStorage.setItem(TOKEN_KEY, location.hash.slice(1));
    } catch {
      /* ignore */
    }
    location.replace(location.pathname);
  }
});

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export function subscribe(onEvent: (e: any) => void, onStatus: (ok: boolean) => void): () => void {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore */
    }
  };
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  return () => es.close();
}

export function exportUrl(runId: string, format: 'html' | 'md' = 'html'): string {
  return `/api/runs/${encodeURIComponent(runId)}/export?format=${format}&token=${encodeURIComponent(token)}`;
}

export interface DesktopBridge {
  platform: string;
  pickFolder(): Promise<string | null>;
  openPath(p: string): Promise<string>;
  notify(o: { title: string; body: string; route?: string }): Promise<boolean>;
  onNavigate(fn: (route: string) => void): void;
}

/** Present when running inside the Electron shell. */
export const desktop = (window as any).duoDesktop as DesktopBridge | undefined;

export const isMac = (desktop?.platform ?? navigator.platform).toLowerCase().startsWith('mac') || desktop?.platform === 'darwin';
/** "⌘" on macOS, "Ctrl" elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';
