import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { PROJECT_ROOT, SCRATCH_DIR } from '../paths.ts';
import { RunContext, type RunOptions } from '../protocols/common.ts';
import { parseSeat } from '../seats.ts';
import type { CoordinationTemplate } from './types.ts';
import { templateErrors, validateTemplate } from './validate.ts';
import { OPERATION_CATALOG } from './operations.ts';

const OUTPUT = {
  type: 'object', properties: { templateJson: { type: 'string' }, explanation: { type: 'string' } },
  required: ['templateJson', 'explanation'], additionalProperties: false,
};
export interface GenerateRequest { description: string; model: string; current?: CoordinationTemplate; safe?: boolean; sink?: RunOptions['sink']; onContext?: (ctx: RunContext) => void; }
/** Compile descriptions to drafts with the chosen local model; validate and repair before returning. */
export async function generateTemplate(cfg: Config, req: GenerateRequest): Promise<{ template: CoordinationTemplate; explanation: string; run: string; }> {
  if (!req.description?.trim() || req.description.length > 30000) throw new Error('Describe the coordination method in 1–30000 characters');
  if (req.current) validateTemplate(req.current);
  const seat = parseSeat(req.model, 'A', cfg.defaults, { safe: req.safe });
  const cwd = join(SCRATCH_DIR, 'template-builder'); mkdirSync(cwd, { recursive: true });
  const ctx = RunContext.create(cfg, { protocol: 'template-builder', title: 'Build coordination template', brief: req.description, cwd, seats: [seat], rounds: 1, minRounds: 1, anon: false, quiet: true, workspace: false, extra: {}, sink: req.sink });
  req.onContext?.(ctx);
  const sessions = [];
  try {
    const docs = readFileSync(join(PROJECT_ROOT, 'docs', 'templates.md'), 'utf8');
    const example = readFileSync(join(PROJECT_ROOT, 'docs', 'templates', 'example.json'), 'utf8');
    const ss = await ctx.engines.openSeat(seat, 'template-author', { cwd, hideSkills: true, schema: OUTPUT, system: `You author Duo coordination templates. Produce a data-only JSON template as templateJson plus a concise explanation. Use the specification below. Do not execute the workflow or change project files. Resolve routine choices with explicit bounded defaults. Use a new id when adapting a built-in. Roles change between turns. All behavior must be expressible in the visual maker. Use generic nodes for custom interactions and the selected operation library for ledger, ranking, review or workspace mechanics. Stage order, prompts, settings and completion policy belong in template data; never assume a report or finish will inject missing stages.\n\n${docs}\n\nOperation catalog (prompt keys, editable defaults and supported settings):\n${JSON.stringify(OPERATION_CATALOG)}\n\nExample:\n${example}` });
    sessions.push(ss); ctx.recordSeats(sessions);
    let message = `Design or revise a Duo coordination template for this request:\n${req.description}${req.current ? `\n\nCurrent template:\n${JSON.stringify(req.current)}` : ''}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      ctx.checkpoint();
      const turn = await ctx.send(ss, message, { round: attempt + 1, kind: attempt ? 'repair-template' : 'draft-template' });
      ctx.checkpoint(); ctx.seatLine(seat, turn);
      if (turn.error) throw new Error(turn.error);
      const result = turn.structured as { templateJson?: unknown; explanation?: unknown; } | undefined;
      let value: unknown;
      let errors: string[];
      try { value = JSON.parse(String(result?.templateJson)); errors = templateErrors(value); }
      catch { errors = ['templateJson must contain valid JSON for a coordination template']; }
      if (!errors.length) {
        const template = validateTemplate(value);
        ctx.store.writeFile('draft-template.json', JSON.stringify(template, null, 2));
        await ctx.finish('completed', { template: template.id, draft: true }, sessions);
        return { template, explanation: String(result?.explanation ?? ''), run: ctx.store.meta.id };
      }
      message = `The draft failed validation. Repair these errors and return the full template again:\n${errors.join('\n')}`;
    }
    throw new Error('The model could not produce a valid template after three drafts. Its attempts are recorded in the builder run.');
  } catch (e) { await ctx.fail(e, sessions); throw e; }
}
