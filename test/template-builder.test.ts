import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CoordinationTemplate, Step } from '../src/templates/types.ts';
import { builtinTemplate } from '../src/templates/builtins.ts';
import { BUILTIN_IDS } from '../src/templates/definitions.ts';
import { OPERATION_CATALOG, operationStep } from '../src/templates/operations.ts';
import { validateTemplate } from '../src/templates/validate.ts';
import { chooseLibrary, insertStep, orderedSteps, removalIssue, removeStep, renameItem, STARTER, stateReferences } from '../gui/src/template-model.ts';

const example = (): CoordinationTemplate => JSON.parse(readFileSync(new URL('../docs/templates/example.json', import.meta.url), 'utf8'));
const nextOf = (step: Step) => 'next' in step ? step.next : undefined;

test('a new visual draft can recreate every shipped method and add every library stage', () => {
  for (const library of BUILTIN_IDS) {
    const draft = chooseLibrary(structuredClone(STARTER), library);
    const builtin = builtinTemplate(library);
    assert.deepEqual(draft, { ...builtin, id: STARTER.id, name: STARTER.name, description: STARTER.description });
    assert.deepEqual(validateTemplate(JSON.parse(JSON.stringify(draft))), JSON.parse(JSON.stringify(draft)), 'all contracts survive the saved definition');
    for (const use of Object.keys(OPERATION_CATALOG).filter((use) => use.startsWith(`${library}.`))) {
      const added = insertStep(draft, 'finish', 'operation');
      added.template.steps[added.id] = operationStep(use, 'finish');
      validateTemplate(added.template);
      assert.equal(nextOf(added.template.steps[added.id]), 'finish');
    }
  }
});

test('library prompt references and input routes participate in visual renames and removal', () => {
  const t = chooseLibrary(structuredClone(STARTER), 'debate');
  const resolve = t.steps.resolve;
  if (resolve.type !== 'operation') throw new Error('fixture');
  resolve.prompts!['ledger-review'] += '\n{{outputs.round.0.reply}}';
  resolve.input = [{ from: 'round', parts: ['data'], excludeSelf: true }];
  const changed = renameItem(t, 'step', 'round', 'discussion');
  const review = changed.steps.resolve;
  assert.ok(stateReferences(changed, 'step', 'discussion'));
  assert.equal(review.type === 'operation' && review.input?.[0].from, 'discussion');
  assert.match(review.type === 'operation' ? review.prompts!['ledger-review'] : '', /outputs.discussion/);
  validateTemplate(changed);
});

test('visual renames preserve routes, assignments, memory and nested state references', () => {
  let t = example();
  t.completion = { when: { all: [{ path: 'outputs.decide.0.data.done', op: 'eq', value: true }, { path: 'visits.decide', op: 'gte', valuePath: 'visits.challenge' }] }, reason: '{{outputs.decide.0.data.answer}}' };
  t.steps.decide = { ...t.steps.decide, prompt: 'decide prose {{outputs.decide.0.reply}}' } as typeof t.steps.decide;
  t = renameItem(t, 'step', 'decide', 'Final decision');
  assert.equal(t.steps['final-decision'].type, 'turn');
  assert.equal(t.memory!.decisions.writeFrom[0], 'final-decision');
  assert.equal(t.completion!.reason, '{{outputs.final-decision.0.data.answer}}');
  assert.equal('prompt' in t.steps['final-decision'] && t.steps['final-decision'].prompt, 'decide prose {{outputs.final-decision.0.reply}}');
  assert.equal('next' in t.steps.challenge && t.steps.challenge.next, 'final-decision');
  t = renameItem(t, 'role', 'decider', 'Decision maker');
  assert.equal(t.transitions![0].to, 'decision-maker');
  assert.deepEqual(t.memory!.decisions.readBy, ['decision-maker']);
  assert.equal('role' in t.steps['final-decision'] && t.steps['final-decision'].role, 'decision-maker');
  validateTemplate(t);
});

test('renaming updates identifiers without rewriting literal comparison objects or descriptions', () => {
  const t = example();
  t.completion = { when: { path: 'outputs.decide.0.data', op: 'eq', value: { path: 'outputs.decide', role: 'decider' } }, reason: 'decide is the old name' };
  const changed = renameItem(t, 'step', 'decide', 'resolve');
  assert.deepEqual('path' in changed.completion!.when && changed.completion!.when.value, { path: 'outputs.decide', role: 'decider' });
  assert.equal(changed.completion!.reason, 'decide is the old name');
  assert.throws(() => renameItem(t, 'role', 'decider', 'propose'), /already in use/);
  assert.throws(() => renameItem(t, 'step', 'decide', 'constructor'), /beginning with a letter/);
});

test('adding turns connects ordinary, branch and terminal paths, including built-in finalizers', () => {
  const turn = insertStep(structuredClone(STARTER), 'answer', 'turn');
  assert.equal('next' in turn.template.steps.answer && turn.template.steps.answer.next, turn.id);
  assert.equal(nextOf(turn.template.steps[turn.id]), 'done');
  validateTemplate(turn.template);
  const before = insertStep(structuredClone(STARTER), 'done', 'assign');
  assert.equal('next' in before.template.steps.answer && before.template.steps.answer.next, before.id);
  assert.equal(nextOf(before.template.steps[before.id]), 'done');
  validateTemplate(before.template);
  const branched = insertStep(example(), 'verify', 'turn');
  assert.equal(branched.template.steps.verify.type === 'branch' && branched.template.steps.verify.otherwise, branched.id);
  assert.equal(nextOf(branched.template.steps[branched.id]), 'blocked');
  validateTemplate(branched.template);
  const native = insertStep(builtinTemplate('pair'), 'finish', 'turn');
  assert.equal(native.template.steps.continue.type === 'branch' && native.template.steps.continue.cases[0].next, native.id);
  assert.equal(nextOf(native.template.steps[native.id]), 'finish');
  validateTemplate(native.template);
});

test('removing a connected turn reconnects the graph and removes its routed/memory outputs', () => {
  const inserted = insertStep(structuredClone(STARTER), 'answer', 'turn');
  const t = inserted.template;
  t.steps.answer = { ...t.steps.answer, input: [{ from: inserted.id }] } as typeof t.steps.answer;
  t.memory = { scratch: { scope: 'run', readBy: ['contributor'], writeFrom: [inserted.id], parts: ['reply'], maxEntries: 2, maxChars: 500 } };
  const removed = removeStep(t, inserted.id);
  assert.equal('next' in removed.steps.answer && removed.steps.answer.next, 'done');
  assert.deepEqual(removed.steps.answer.type === 'turn' && removed.steps.answer.input, []);
  assert.deepEqual(removed.memory, {});
  validateTemplate(removed);
  const branched = insertStep(structuredClone(STARTER), 'answer', 'branch');
  const withoutBranch = removeStep(branched.template, branched.id);
  assert.equal(nextOf(withoutBranch.steps.answer), 'done');
  validateTemplate(withoutBranch);
});

test('removal catches true state references while leaving similarly named steps independent', () => {
  const t = example();
  assert.ok(removalIssue(t, 'decide'));
  assert.equal(stateReferences(t, 'step', 'decid'), false);
  t.completion = { when: { path: 'memory.decisions', op: 'exists' }, reason: 'Done' };
  assert.equal(stateReferences(t, 'memory', 'decisions'), true);
  const renamed = renameItem(t, 'memory', 'decisions', 'Past decisions');
  assert.equal('path' in renamed.completion!.when && renamed.completion!.when.path, 'memory.past-decisions');
  assert.equal(stateReferences(renamed, 'memory', 'decisions'), false);
});

test('workflow ordering handles cycles and shows disconnected editable steps once', () => {
  const t = builtinTemplate('debate');
  t.steps.extra = { type: 'finish', status: 'blocked', reason: 'Needs input' };
  const ids = orderedSteps(t);
  assert.equal(ids[0], t.start);
  assert.equal(new Set(ids).size, Object.keys(t.steps).length);
  assert.ok(ids.includes('extra'));
});
