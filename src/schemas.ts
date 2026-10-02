/**
 * Structured-output schemas. Both CLIs enforce them (codex --output-schema, claude --json-schema),
 * which is what makes the claim ledger, stance matrix and citation checks machine-checkable.
 * They follow OpenAI strict mode: every property required, additionalProperties false, and
 * optionality expressed as a null union.
 */

const evidence = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'ref', 'quote'],
  properties: {
    type: { type: 'string', enum: ['file', 'command', 'doc', 'reasoning'] },
    ref: { type: 'string', description: 'file: path:line or path:start-end; command: the exact command; doc: URL or title; reasoning: short label' },
    quote: { type: ['string', 'null'], description: 'Short verbatim text from the file or output that supports the claim, or null' },
  },
};

export const DEBATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'claims', 'stances', 'concessions', 'verdict', 'open_points', 'assumptions', 'confidence'],
  properties: {
    answer: { type: 'string', description: 'Your complete current position in Markdown, conclusion first.' },
    claims: {
      type: 'array',
      description: 'Your position broken into atomic claims. Keep ids stable across rounds (c1, c2, ...).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'kind', 'confidence', 'evidence'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['fact', 'judgment', 'prediction'] },
          confidence: { type: 'number', description: '0 to 1' },
          evidence: { type: 'array', items: evidence },
        },
      },
    },
    stances: {
      type: 'array',
      description: "Your stance on peers' claims, by global id such as B:c2. Empty in round 1.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'stance', 'reason'],
        properties: {
          claim: { type: 'string' },
          stance: { type: 'string', enum: ['agree', 'partial', 'disagree', 'unsure'] },
          reason: { type: 'string' },
        },
      },
    },
    concessions: { type: 'array', items: { type: 'string' }, description: 'What you changed your mind about this round and what persuaded you.' },
    verdict: { type: 'string', enum: ['agree', 'partial', 'disagree', 'n/a'], description: "Relative to the peers' latest answers; n/a in round 1." },
    open_points: { type: 'array', items: { type: 'string' }, description: 'What still separates you, each with the evidence that would settle it.' },
    assumptions: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', description: 'Overall confidence in your answer, 0 to 1' },
  },
};

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'assessments', 'verdict', 'confidence'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences on the overall state of the work.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'title', 'location', 'problem', 'scenario', 'fix', 'confidence', 'quote'],
        properties: {
          id: { type: 'string', description: 'f1, f2, ... stable across rounds' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'P0 correctness/security/data loss, P1 likely bug, P2 maintainability/perf, P3 nit' },
          title: { type: 'string' },
          location: { type: 'string', description: 'path:line or path:start-end' },
          problem: { type: 'string' },
          scenario: { type: 'string', description: 'Concrete input or state that triggers it' },
          fix: { type: 'string' },
          confidence: { type: 'number' },
          quote: { type: ['string', 'null'], description: 'The offending code, verbatim and short, or null' },
        },
      },
    },
    assessments: {
      type: 'array',
      description: "Round 2+: your verdict on other reviewers' findings, by global id such as B:f3.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'stance', 'reason'],
        properties: {
          finding: { type: 'string' },
          stance: { type: 'string', enum: ['confirm', 'reject', 'unsure'] },
          reason: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['ship', 'ship-after-fixes', 'rethink'] },
    confidence: { type: 'number' },
  },
};

export const RANKING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ranking', 'critiques', 'best_points', 'errors'],
  properties: {
    ranking: { type: 'array', items: { type: 'string' }, description: 'Response labels from best to worst, e.g. ["R2", "R1"]' },
    critiques: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['response', 'strengths', 'weaknesses'],
        properties: { response: { type: 'string' }, strengths: { type: 'string' }, weaknesses: { type: 'string' } },
      },
    },
    best_points: { type: 'array', items: { type: 'string' }, description: 'The strongest ideas across all responses, each tagged with its label' },
    errors: { type: 'array', items: { type: 'string' }, description: 'Factual or logical errors, each tagged with its label' },
  },
};

export interface Evidence {
  type: 'file' | 'command' | 'doc' | 'reasoning';
  ref: string;
  quote: string | null;
}

export interface DebateTurn {
  answer: string;
  claims: { id: string; text: string; kind: string; confidence: number; evidence: Evidence[] }[];
  stances: { claim: string; stance: string; reason: string }[];
  concessions: string[];
  verdict: string;
  open_points: string[];
  assumptions: string[];
  confidence: number;
}

export interface ReviewTurn {
  summary: string;
  findings: { id: string; severity: string; title: string; location: string; problem: string; scenario: string; fix: string; confidence: number; quote: string | null }[];
  assessments: { finding: string; stance: string; reason: string }[];
  verdict: string;
  confidence: number;
}

export interface RankingTurn {
  ranking: string[];
  critiques: { response: string; strengths: string; weaknesses: string }[];
  best_points: string[];
  errors: string[];
}

/** Light shape checks: the CLIs enforce the schema, but a failed or truncated turn can still slip through. */
export function asDebateTurn(x: unknown): DebateTurn | undefined {
  const o = x as DebateTurn;
  if (!o || typeof o.answer !== 'string' || !Array.isArray(o.claims)) return undefined;
  return {
    answer: o.answer,
    claims: o.claims.filter((c) => c && typeof c.id === 'string' && typeof c.text === 'string').map((c) => ({ ...c, evidence: Array.isArray(c.evidence) ? c.evidence : [] })),
    stances: Array.isArray(o.stances) ? o.stances.filter((s) => s && typeof s.claim === 'string') : [],
    concessions: Array.isArray(o.concessions) ? o.concessions : [],
    verdict: typeof o.verdict === 'string' ? o.verdict : 'n/a',
    open_points: Array.isArray(o.open_points) ? o.open_points : [],
    assumptions: Array.isArray(o.assumptions) ? o.assumptions : [],
    confidence: typeof o.confidence === 'number' ? o.confidence : NaN,
  };
}

export function asReviewTurn(x: unknown): ReviewTurn | undefined {
  const o = x as ReviewTurn;
  if (!o || !Array.isArray(o.findings)) return undefined;
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    findings: o.findings.filter((f) => f && typeof f.id === 'string'),
    assessments: Array.isArray(o.assessments) ? o.assessments.filter((a) => a && typeof a.finding === 'string') : [],
    verdict: typeof o.verdict === 'string' ? o.verdict : 'ship-after-fixes',
    confidence: typeof o.confidence === 'number' ? o.confidence : NaN,
  };
}

export function asRankingTurn(x: unknown): RankingTurn | undefined {
  const o = x as RankingTurn;
  if (!o || !Array.isArray(o.ranking)) return undefined;
  return {
    ranking: o.ranking.filter((r) => typeof r === 'string'),
    critiques: Array.isArray(o.critiques) ? o.critiques : [],
    best_points: Array.isArray(o.best_points) ? o.best_points : [],
    errors: Array.isArray(o.errors) ? o.errors : [],
  };
}

// ── pair (writer / reviewer loop) ────────────────────────────────────────

export const PAIR_WRITER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'changes', 'tests', 'responses', 'blocker'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'], description: 'done: you believe the request is fully implemented. blocked: you cannot continue without something only a person can provide.' },
    summary: { type: 'string', description: 'What you did this turn and why, in Markdown, for the reviewer and the user.' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'description'],
        properties: { path: { type: 'string' }, description: { type: 'string' } },
      },
    },
    tests: {
      type: 'array',
      description: 'Commands you ran to check the work (build, tests, linters) and what happened.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'outcome', 'details'],
        properties: {
          command: { type: 'string' },
          outcome: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
          details: { type: 'string' },
        },
      },
    },
    responses: {
      type: 'array',
      description: "One entry per finding from the reviewer's last review: fixed, disputed (with evidence) or deferred.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'action', 'note'],
        properties: {
          finding: { type: 'string', description: 'The finding id, e.g. f2' },
          action: { type: 'string', enum: ['fixed', 'disputed', 'deferred'] },
          note: { type: 'string' },
        },
      },
    },
    blocker: { type: ['string', 'null'], description: 'When blocked: what is missing. Otherwise null.' },
  },
};

export const PAIR_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'requirements', 'findings', 'resolved', 'confidence'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'], description: 'approve only when the request is fully and correctly implemented and no P0/P1 finding is open.' },
    summary: { type: 'string', description: 'Your assessment in two to five sentences.' },
    requirements: {
      type: 'array',
      description: "The user's request broken into checkable requirements, each judged against the code.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement', 'met', 'evidence'],
        properties: {
          requirement: { type: 'string' },
          met: { type: 'string', enum: ['yes', 'partly', 'no'] },
          evidence: { type: 'string', description: 'path:line, test output, or why' },
        },
      },
    },
    findings: {
      type: 'array',
      description: 'Every issue still open, including ones from earlier reviews (keep their ids). New issues get new ids.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'title', 'location', 'problem', 'fix'],
        properties: {
          id: { type: 'string', description: 'f1, f2, ... stable across reviews' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'P0 broken/unsafe/data loss, P1 a real bug or a missing part of the request, P2 should fix, P3 nit' },
          title: { type: 'string' },
          location: { type: 'string', description: 'path:line or path:start-end' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    resolved: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier findings that are now resolved (fixed, or the writer showed they were wrong).' },
    confidence: { type: 'number', description: '0 to 1' },
  },
};

export interface PairWriterTurn {
  status: 'done' | 'blocked';
  summary: string;
  changes: { path: string; description: string }[];
  tests: { command: string; outcome: string; details: string }[];
  responses: { finding: string; action: string; note: string }[];
  blocker: string | null;
}

export interface PairReviewTurn {
  verdict: 'approve' | 'request_changes';
  summary: string;
  requirements: { requirement: string; met: string; evidence: string }[];
  findings: { id: string; severity: string; title: string; location: string; problem: string; fix: string }[];
  resolved: string[];
  confidence: number;
}

export function asPairWriterTurn(x: unknown): PairWriterTurn | undefined {
  const o = x as PairWriterTurn;
  if (!o || typeof o.summary !== 'string') return undefined;
  return {
    status: o.status === 'blocked' ? 'blocked' : 'done',
    summary: o.summary,
    changes: Array.isArray(o.changes) ? o.changes.filter((c) => c && typeof c.path === 'string') : [],
    tests: Array.isArray(o.tests) ? o.tests.filter((t) => t && typeof t.command === 'string') : [],
    responses: Array.isArray(o.responses) ? o.responses.filter((r) => r && typeof r.finding === 'string') : [],
    blocker: typeof o.blocker === 'string' && o.blocker.trim() ? o.blocker : null,
  };
}

export function asPairReviewTurn(x: unknown): PairReviewTurn | undefined {
  const o = x as PairReviewTurn;
  if (!o || (o.verdict !== 'approve' && o.verdict !== 'request_changes') || !Array.isArray(o.findings)) return undefined;
  return {
    verdict: o.verdict,
    summary: typeof o.summary === 'string' ? o.summary : '',
    requirements: Array.isArray(o.requirements) ? o.requirements.filter((r) => r && typeof r.requirement === 'string') : [],
    findings: o.findings.filter((f) => f && typeof f.id === 'string'),
    resolved: Array.isArray(o.resolved) ? o.resolved.filter((r) => typeof r === 'string') : [],
    confidence: typeof o.confidence === 'number' ? o.confidence : NaN,
  };
}
