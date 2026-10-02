import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Engine } from './types.ts';

// ── icons (stroked, 24px grid) ───────────────────────────────────────────

const PATHS: Record<string, JSX.Element> = {
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  chat: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4V16h0A1.5 1.5 0 0 1 4 14.5z" />,
  split: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M12 4v16" /></>,
  debate: <><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h8A1.5 1.5 0 0 1 14 6.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V13h-.5A1.5 1.5 0 0 1 3 11.5z" /><path d="M17 9h2.5A1.5 1.5 0 0 1 21 10.5v5a1.5 1.5 0 0 1-1.5 1.5H19v2.5L16 17h-4.5a1.5 1.5 0 0 1-1.5-1.5V16" /></>,
  review: <><circle cx="11" cy="11" r="6.5" /><path d="M20.5 20.5l-4.6-4.6M8.5 11l1.8 1.8 3.4-3.6" /></>,
  council: <><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M2.5 19c.5-3 3-5 5.5-5s5 2 5.5 5M14 14.5c.9-.4 1.9-.5 3-.5 2.4 0 4.5 1.6 5 4" /></>,
  ask: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></>,
  pair: <><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /><path d="M13.5 4l-3 16" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  'folder-off': <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M4 4l16 16" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v5h-5" /></>,
  retry: <><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v5h5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  'check-circle': <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 9.8" /></>,
  'x-circle': <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  alert: <><path d="M12 3.5l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9l3 3-3 3M12.5 15H17" /></>,
  file: <><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /></>,
  edit: <path d="M4 20h4l11-11-4-4L4 16zM13.5 6.5l4 4" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></>,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M9 7V4.5h6V7M6 7l1 13h10l1-13" />,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 5-7 4-10 8.5" /></>,
  merge: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="17" r="2" /><path d="M6 7v10M6 7c0 6 6 10 10 10" /></>,
  down: <path d="M6 9l6 6 6-6" />,
  up: <path d="M6 15l6-6 6 6" />,
  right: <path d="M9 6l6 6-6 6" />,
  left: <path d="M15 6l-6 6 6 6" />,
  dots: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  shield: <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20.5 20.5l-4.6-4.6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  forward: <path d="M4 12h14M13 6l6 6-6 6" />,
  pin: <path d="M14.5 3.5l6 6-3 1-3.5 3.5-.5 4-3-3-5 5M9.5 10.5l-3-3 4-.5L14 3.5" />,
  command: <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  zap: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  home: <path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  bell: <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></>,
  wrench: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z" />,
  layers: <path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 20c1-4 4-6 8-6s7 2 8 6" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
};

export function Icon({ name, size = 16, class: cls }: { name: string; size?: number; class?: string }) {
  return (
    <svg class={`icon ${cls ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {PATHS[name] ?? PATHS.dots}
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span class="spinner" style={{ width: size, height: size }} aria-label="working" />;
}

export function EngineDot({ engine }: { engine: Engine }) {
  return <span class={`dot dot-${engine}`} title={engine === 'claude' ? 'Claude' : 'Codex'} />;
}

/** The round engine mark used for avatars and seat chips. */
export function EngineMark({ engine, size = 22 }: { engine: Engine; size?: number }) {
  return (
    <span class={`mark mark-${engine}`} style={{ width: size, height: size }} aria-label={engine === 'claude' ? 'Claude' : 'Codex'}>
      {engine === 'claude' ? (
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="currentColor"><path d="M12 2.5l1.6 6.2 6-2.4-4.3 4.9 5.2 3.6-6.4.3.9 6.4L12 16l-3 5.5.9-6.4-6.4-.3 5.2-3.6-4.3-4.9 6 2.4z" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /></svg>
      )}
    </span>
  );
}

export function EngineName({ engine }: { engine: Engine }) {
  return <span class={`engine-name ${engine}`}>{engine === 'claude' ? 'Claude' : 'Codex'}</span>;
}

/** The Duo logo: two overlapping marks in the engines' colors. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 32 32" aria-label="Duo">
      <defs>
        <linearGradient id="duo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--claude)" />
          <stop offset="1" stop-color="var(--codex)" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="16" r="9" fill="var(--claude)" opacity="0.9" />
      <circle cx="20" cy="16" r="9" fill="var(--codex)" opacity="0.9" />
      <path d="M16 8.6a9 9 0 0 1 0 14.8 9 9 0 0 1 0-14.8z" fill="url(#duo-g)" />
    </svg>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>;
}

// ── dropdown / menu ──────────────────────────────────────────────────────

export function Dropdown({ trigger, children, align = 'left', up = false, class: cls }: { trigger: (open: boolean, toggle: () => void) => ComponentChildren; children: (close: () => void) => ComponentChildren; align?: 'left' | 'right'; up?: boolean; class?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div class={`dropdown ${cls ?? ''}`} ref={ref}>
      {trigger(open, () => setOpen(!open))}
      {open && <div class={`menu ${align} ${up ? 'up' : ''}`} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem({ onClick, children, active, danger, hint, icon, disabled }: { onClick: () => void; children: ComponentChildren; active?: boolean; danger?: boolean; hint?: ComponentChildren; icon?: string; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" class={`menu-item ${active ? 'active' : ''} ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>
      {icon && <Icon name={icon} size={15} />}
      <span class="menu-label">{children}</span>
      {hint && <span class="menu-hint">{hint}</span>}
      {active && <Icon name="check" size={14} />}
    </button>
  );
}

export function MenuSeparator() {
  return <div class="menu-sep" role="separator" />;
}

// ── modal ────────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, wide, footer }: { title: ComponentChildren; onClose: () => void; children: ComponentChildren; wide?: boolean; footer?: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>{title}</h2>
          <button type="button" class="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: ComponentChildren; count?: number }[]; active: T; onChange: (t: T) => void }) {
  return (
    <div class="tabs" role="tablist">
      {tabs.map((t) => (
        <button type="button" role="tab" aria-selected={t.id === active} class={`tab ${t.id === active ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span class="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size }: { value: T; options: { id: T; label: ComponentChildren; title?: string }[]; onChange: (v: T) => void; size?: 'small' }) {
  return (
    <div class={`seg ${size ?? ''}`} role="radiogroup">
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={o.id === value} class={o.id === value ? 'on' : ''} title={o.title} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; hint?: ComponentChildren }) {
  return (
    <label class="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="toggle-track"><span class="toggle-thumb" /></span>
      <span class="toggle-text">{label}{hint && <span class="toggle-hint">{hint}</span>}</span>
    </label>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <div class="empty-icon"><Icon name={icon} size={22} /></div>
      <div class="empty-title">{title}</div>
      {children && <div class="empty-body">{children}</div>}
    </div>
  );
}

/** Elapsed time that ticks while something runs. */
export function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span class="elapsed">{dur(Date.now() - since)}</span>;
}

// ── formatting ───────────────────────────────────────────────────────────

export function kfmt(n?: number): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v);
}

export function dur(ms?: number): string {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Today / Yesterday / Previous 7 days / Previous 30 days / Month Year, for grouping lists. */
export function dayGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return 'Today';
  if (t >= start - 86400_000) return 'Yesterday';
  if (t >= start - 7 * 86400_000) return 'Previous 7 days';
  if (t >= start - 30 * 86400_000) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Last path component, for / and \ paths alike. */
export function base(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p || '/';
}

export function when(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}`;
}

export function untilText(epochSec: number): string {
  const s = epochSec - Date.now() / 1000;
  if (s <= 0) return 'now';
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
}

export function money(credits?: number, usd?: number): string {
  if (credits !== undefined) return `${credits < 10 ? credits.toFixed(2) : credits.toFixed(1)} cr`;
  if (usd !== undefined) return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
  return '';
}
