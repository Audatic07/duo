import { usageSection } from '../render.ts';
import type { RunContext } from '../protocols/common.ts';
import type { CoordinationTemplate, Operations, WorkflowState } from './types.ts';
import { assign, executeWorkflow, selected } from './runtime.ts';
import type { Seat } from '../seats.ts';
import { validateTemplate } from './validate.ts';
import { builtinDefinition, templateSchema, type Builtin } from './definitions.ts';
export { BUILTIN_IDS, type Builtin } from './definitions.ts';
export function builtinTemplate(id: Builtin): CoordinationTemplate {
  return validateTemplate(builtinDefinition(id));
}
export function nativeSchema(ctx: RunContext, role: string, fallback?: object): object | undefined {
  return templateSchema(ctx.opts.extra.template as CoordinationTemplate | undefined, role, fallback);
}
/** Native roles honor the same starting assignments that the visual maker edits. */
export function nativeSeats(ctx: RunContext, role: string, fallback: Seat[] = ctx.opts.seats): Seat[] {
  const template = ctx.opts.extra.template as CoordinationTemplate | undefined;
  if (!template?.assignments.some((a) => a.role === role)) {
    if (template && (role === 'participant' || template.library === 'pair')) return [];
    return fallback;
  }
  const roles = Object.fromEntries(Object.keys(template.roles).map((id) => [id, [] as string[]]));
  const state = { roles } as WorkflowState;
  for (const a of template.assignments) assign(state, a.role, selected(a.select, ctx.opts.seats, roles), true);
  return ctx.opts.seats.filter((seat) => roles[role]?.includes(seat.id));
}
/** An explicit chair assignment takes priority over the optional run-level chair. */
export function nativeChair(ctx: RunContext): Seat | undefined {
  const template = ctx.opts.extra.template as CoordinationTemplate | undefined;
  if (template?.assignments.some((a) => a.role === 'chair')) {
    const seats = nativeSeats(ctx, 'chair', []);
    if (seats.length !== 1) throw new Error('Assign exactly one model to the chair role');
    return seats[0];
  }
  return ctx.opts.chair ? { ...ctx.opts.chair, id: 'Z' } : undefined;
}
export async function runBuiltin(ctx: RunContext, id: Builtin, operations: Operations, onStopped?: (state: WorkflowState) => Promise<void>): Promise<WorkflowState> {
  const supplied = ctx.opts.extra.template as CoordinationTemplate | undefined;
  const template = supplied ?? builtinTemplate(id);
  if (template.library !== id) throw new Error(`Template needs the ${id} operation library`);
  const state = await executeWorkflow(ctx, template, operations, undefined, builtinTemplate(id).roles);
  if (state.stop && ctx.store.meta.status === 'running') {
    if (onStopped) {
      await onStopped(state);
      return state;
    }
    const stop = state.stop;
    await ctx.finish(stop.status === 'failed' ? 'failed' : 'completed', { stop: stop.reason, completion: stop.status, converged: stop.status === 'completed', template: template.id }, []);
    const report = [`# ${ctx.store.meta.title}`, '', `**Outcome:** ${stop.reason}`, ...state.history.flatMap((m) => ['', `## ${m.role} / ${m.seat} — ${m.step}`, '', m.reply || m.error || '']), '', usageSection(ctx.store.meta)].join('\n');
    ctx.store.writeFile('report.md', report);
  }
  return state;
}
