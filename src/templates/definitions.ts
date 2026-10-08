/** Browser-safe template definitions: the maker and runtime start from identical data. */
import { DEBATE_SCHEMA, PAIR_REVIEW_SCHEMA, PAIR_WRITER_SCHEMA, RANKING_SCHEMA, REVIEW_SCHEMA } from '../schemas.ts';
import { operationStep } from './operations.ts';
import type { CoordinationTemplate } from './types.ts';

export const BUILTIN_IDS = ['pair', 'debate', 'review', 'council', 'ask'] as const;
export type Builtin = (typeof BUILTIN_IDS)[number];
const sequences: Record<Builtin, string[]> = {
  ask: ['answers', 'chair', 'finish'], review: ['independent', 'crosscheck', 'merge', 'chair', 'finish'],
  council: ['answers', 'rank', 'aggregate', 'chair', 'finish'], debate: ['round', 'resolve', 'report', 'chair', 'finish'], pair: ['prepare', 'cycle', 'finish'],
};
export function builtinDefinition(id: Builtin): CoordinationTemplate {
  const seq = sequences[id];
  const steps: CoordinationTemplate['steps'] = {};
  for (const [i, name] of seq.entries()) steps[name] = operationStep(`${id}.${name}`, seq[i + 1] ?? name);
  if (id === 'pair' || id === 'debate') {
    const loop = id === 'pair' ? 'cycle' : 'round';
    steps[loop] = { ...steps[loop], next: 'continue' } as CoordinationTemplate['steps'][string];
    steps.continue = { type: 'branch', cases: [{ when: { path: 'vars.done', op: 'eq', value: true }, next: id === 'pair' ? 'finish' : 'resolve' }], otherwise: loop };
  }
  const t: CoordinationTemplate = {
    version: 1, id, name: id[0].toUpperCase() + id.slice(1), library: id,
    description: {
      ask: 'Independent answers, optional chair comparison.',
      review: 'Independent findings, verified locations, cross-validation, merge and optional chair.',
      council: 'Independent answers, fresh anonymous rankings excluding self, Borda aggregation and optional chair.',
      debate: 'Blind positions, cross-examination, final agree/disagree review of every ledger claim, optional chair.',
      pair: 'Isolated writer/reviewer cycles, checks, finding history, blocked/deadlock detection and apply controls.',
    }[id],
    roles: id === 'pair' ? {
      writer: { instructions: 'Implement the request, run checks, respond to findings. Uses the run’s writer permissions and schemas.', schema: PAIR_WRITER_SCHEMA },
      reviewer: { instructions: 'Read-only review of the diff against the request; approve or file findings.', schema: PAIR_REVIEW_SCHEMA },
    } : {
      participant: { instructions: 'Follow the library’s structured protocol and role rules.', ...(id === 'debate' ? { schema: DEBATE_SCHEMA } : id === 'review' ? { schema: REVIEW_SCHEMA } : {}) },
      ...(id === 'council' ? { reviewer: { instructions: 'In a fresh context, rank anonymous peer answers, with own answer excluded.', schema: RANKING_SCHEMA } } : {}),
      chair: { instructions: 'Synthesize the verified record while retaining disagreement.' },
    },
    assignments: id === 'pair' ? [{ role: 'writer', select: { ids: ['A'] } }, { role: 'reviewer', select: { ids: ['B'] } }] : [{ role: 'participant', select: {} }],
    start: seq[0], steps,
    limits: { maxSteps: 10000, maxTurns: 1000, maxDurationSec: 86400, maxContextChars: 1_000_000, minSeats: ['pair', 'debate', 'council'].includes(id) ? 2 : 1 },
  };
  return structuredClone(t);
}

export function templateSchema(template: CoordinationTemplate | undefined, role: string, fallback?: object): object | undefined {
  return template?.roles[role]?.schema ?? fallback;
}
