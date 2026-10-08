import { ask } from '../protocols/ask.ts';
import type { RunContext } from '../protocols/common.ts';
import { council } from '../protocols/council.ts';
import { debate } from '../protocols/debate.ts';
import { pair, pairSettingsOf } from '../protocols/pair.ts';
import { review, type ReviewTarget } from '../protocols/review.ts';
import { customTemplate } from './runtime.ts';
import type { CoordinationTemplate } from './types.ts';
import { validateTemplate } from './validate.ts';

export async function runTemplate(ctx: RunContext, value: CoordinationTemplate): Promise<string> {
  const t = validateTemplate(value);
  ctx.opts.extra.template = t;
  if (!t.library) return customTemplate(ctx, t);
  if (t.library === 'ask') return ask(ctx);
  if (t.library === 'council') return council(ctx);
  if (t.library === 'debate') return debate(ctx);
  if (t.library === 'pair') return pair(ctx, pairSettingsOf(ctx.opts.extra));
  return review(ctx, ctx.opts.extra.target as ReviewTarget ?? { kind: 'uncommitted' }, ctx.opts.extra.focus as string | undefined);
}
