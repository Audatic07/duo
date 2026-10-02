import type { Usage } from './store.ts';

/**
 * Codex credits per 1M tokens at Standard speed (input / cached input / output), from the Codex
 * pricing page (learn.chatgpt.com/docs/pricing, October 2026). ChatGPT plans meter Codex in these
 * credits, so they are the honest unit for comparing seats; USD figures would be API-equivalent
 * fiction on a subscription.
 */
const CODEX_CREDITS: Record<string, [number, number, number]> = {
  'gpt-6-astra': [250, 25, 1250],
  'gpt-6.1-sol': [50, 2.5, 250],
  'gpt-6-sol': [50, 5, 250],
  'gpt-6-luna': [2.5, 0.25, 12.5],
  'gpt-5.6-sol': [100, 10, 500],
  'gpt-5.6-terra': [50, 5, 300],
  'gpt-5.6-luna': [5, 0.5, 30],
  'gpt-5.5': [125, 12.5, 750],
};
/** Fast mode costs twice the Standard rate. */
const FAST_MULTIPLIER = 2;

/**
 * The rate card entry for a model. A model newer than this table (gpt-6.2-sol, say) is priced like
 * the closest one of its family and flagged as an estimate, rather than shown as free.
 */
export function codexRate(model: string): { rate: [number, number, number]; estimated: boolean } | undefined {
  const exact = CODEX_CREDITS[model];
  if (exact) return { rate: exact, estimated: false };
  const m = /^gpt-(\d+)(?:\.(\d+))?-([a-z]+)/.exec(model);
  if (!m) return undefined;
  const family = Object.keys(CODEX_CREDITS)
    .filter((k) => k.startsWith(`gpt-${m[1]}`) && k.endsWith(`-${m[3]}`))
    .sort()
    .pop();
  return family ? { rate: CODEX_CREDITS[family], estimated: true } : undefined;
}

export function codexCredits(model: string, u: Usage, tier?: string): number | undefined {
  const r = codexRate(model);
  if (!r) return undefined;
  const [inRate, cachedRate, outRate] = r.rate;
  const fresh = Math.max(0, u.input - u.cached);
  const credits = (fresh * inRate + u.cached * cachedRate + u.output * outRate) / 1e6;
  return tier === 'fast' || tier === 'priority' ? credits * FAST_MULTIPLIER : credits;
}

export function knownCodexRates(): Record<string, [number, number, number]> {
  return CODEX_CREDITS;
}
