/** Shared catalog for the executor, validator and visual maker. No UI-only operation contracts. */
import type { CoordinationTemplate, Step } from './types.ts';

export interface OperationSetting {
  label: string;
  hint?: string;
  type: 'boolean' | 'integer' | 'choice';
  default: boolean | number | string;
  min?: number;
  max?: number;
  choices?: { value: string; label: string; }[];
}
export interface OperationDefinition {
  name: string;
  hint: string;
  prompts?: Record<string, string>;
  settings?: Record<string, OperationSetting>;
}

export const LEDGER_REVIEW_PROMPT = [
  'Discussion rounds are complete. Review the final, frozen claim ledger and establish agreement or disagreement.', '',
  '<final_positions>', '{{finalPositions}}', '</final_positions>', '', '<claim_ledger>', '{{claimLedger}}', '</claim_ledger>', '',
  'You are participant {{seat}}. Required peer claim ids: {{requiredClaims}}.',
  '1. Return exactly one stance on EVERY required peer claim, including claims previously agreed. Use {{decisions}}, with a substantive reason for each. If you partly agree or lack evidence to endorse the claim as written, explain the accepted part or uncertainty in the reason. Do not force agreement.',
  '2. The ledger and final positions are frozen. Return claims: [] and concessions: []; do not add, edit or withdraw claims. Keep answer equal to your final position above. This review records decisions about those exact claims, not another discussion round.',
  '3. verdict applies to the final peer positions above: "agree" only if you would sign every answer as written apart from wording, "partial" if the core agrees but differences remain, or "disagree" otherwise. Do not use "n/a".',
  '4. open_points: explain remaining disagreements and the evidence or test that would settle them. Return the usual JSON object.',
].join('\n');

const native = '{{nativePrompt}}';
const chair = { name: 'Chair synthesis', hint: 'The optional chair synthesizes the checked record, preserving disagreement.', prompts: { synthesis: native } };
const finish = { name: 'Finish & save report', hint: 'Save the report, outcome and usage, then close model sessions.' };
const rounds: OperationSetting = { label: 'Maximum rounds / cycles', type: 'integer', min: 0, max: 1000, default: 0, hint: '0 uses the run’s round input.' };
export const OPERATION_CATALOG: Record<string, OperationDefinition> = {
  'ask.answers': { name: 'Independent answers', hint: 'Each participant answers the brief independently.', prompts: { answer: native } },
  'ask.chair': chair, 'ask.finish': finish,
  'review.independent': { name: 'Independent reviews', hint: 'Each model reviews the target; finding locations and citations are checked.', prompts: { review: native } },
  'review.crosscheck': { name: 'Cross-check findings', hint: 'Reviewers validate each other’s findings.', prompts: { crosscheck: native } },
  'review.merge': { name: 'Merge findings', hint: 'Combine duplicates while retaining support, disputes and evidence.' },
  'review.chair': chair, 'review.finish': finish,
  'council.answers': { name: 'Independent answers', hint: 'Participants answer the same brief independently.', prompts: { answer: native } },
  'council.rank': { name: 'Anonymous rankings', hint: 'Fresh reviewers rank peers’ anonymous answers, excluding their own.', prompts: { rank: native } },
  'council.aggregate': { name: 'Combine rankings', hint: 'Aggregate peer rankings with Borda scoring.' },
  'council.chair': chair, 'council.finish': finish,
  'debate.round': {
    name: 'Debate round', hint: 'Publish positions, check citations and update the ledger. Publishes vars.done and vars.ledger.',
    prompts: { position: native, critique: native },
    settings: {
      rounds, minRounds: { ...rounds, label: 'Minimum discussion rounds' },
      requireStances: { label: 'Require stances during cross-examination', type: 'boolean', default: true },
      stopOnConvergence: { label: 'End discussion when all claims and verdicts agree', type: 'boolean', default: true },
      stopOnStall: { label: 'End discussion when stances stop changing', type: 'boolean', default: true },
      stallAfter: { label: 'Earliest discussion round for a stall', type: 'integer', min: 2, max: 1000, default: 3 },
      focusOpenAfter: { label: 'Show only open claims from round', type: 'integer', min: 2, max: 1001, default: 3, hint: '1001 keeps all claims visible throughout a run.' },
    },
  },
  'debate.resolve': {
    name: 'Final ledger review', hint: 'Review frozen claims. Publishes vars.reviewComplete, vars.reviewAddressed and vars.ledger.',
    prompts: { 'ledger-review': LEDGER_REVIEW_PROMPT },
    settings: {
      decisions: { label: 'Per-claim decisions', type: 'choice', default: 'binary', choices: [{ value: 'binary', label: 'Agree or disagree' }, { value: 'graded', label: 'Agree, partial, disagree or unsure' }] },
      requireAllClaims: { label: 'Require a decision on every peer claim', type: 'boolean', default: true },
      requireReasons: { label: 'Require a reason for every decision', type: 'boolean', default: true },
    },
  },
  'debate.report': { name: 'Build debate report', hint: 'Prepare claim decisions, disagreements and supporting evidence.' },
  'debate.chair': chair,
  'debate.finish': { ...finish, settings: {
    requireLedgerReview: { label: 'Require a final ledger review before completion', type: 'boolean', default: true },
    requireAddressedClaims: { label: 'Require every active claim to be addressed', type: 'boolean', default: true },
  } },
  'pair.prepare': { name: 'Set up workspace', hint: 'Prepare the isolated writer workspace and reviewer context.' },
  'pair.cycle': { name: 'Write, check & review', hint: 'The writer implements, checks run, and the reviewer verifies. Publishes vars.done.', prompts: { implement: native, revise: native, review: native }, settings: { rounds } },
  'pair.finish': finish,
};

export function operationStep(use: string, next: string): Extract<Step, { type: 'operation' }> {
  const def = OPERATION_CATALOG[use];
  if (!def) throw new Error(`Unknown operation ${use}`);
  return { type: 'operation', use, next,
    ...(def.prompts ? { prompts: { ...def.prompts } } : {}),
    ...(def.settings ? { settings: Object.fromEntries(Object.entries(def.settings).map(([k, v]) => [k, v.default])) } : {}),
  };
}
export function operationSettings(use: string, step?: Extract<Step, { type: 'operation' }>): Record<string, boolean | number | string> {
  return { ...Object.fromEntries(Object.entries(OPERATION_CATALOG[use]?.settings ?? {}).map(([k, v]) => [k, v.default])), ...step?.settings };
}

export function templateOperationSettings(template: CoordinationTemplate | undefined, use: string, stepId?: string): Record<string, boolean | number | string> {
  const step = stepId ? template?.steps[stepId] : Object.values(template?.steps ?? {}).find((s) => s.type === 'operation' && s.use === use);
  return operationSettings(use, step?.type === 'operation' && step.use === use ? step : undefined);
}
