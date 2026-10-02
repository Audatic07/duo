import type { CitationResult } from './citations.ts';
import type { ClaimLedger, RoundStats } from './ledger.ts';
import { fmtWhen } from './quota.ts';
import type { DebateTurn, ReviewTurn } from './schemas.ts';
import type { RunMeta, TurnRecord } from './store.ts';

export function kfmt(n: number | undefined): string {
  const v = n ?? 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v);
}

export function fmtTurnLine(t: Pick<TurnRecord, 'round' | 'kind' | 'durationMs' | 'usage' | 'codexCredits' | 'usd' | 'verdict'> & { tools: unknown[] | number }, label: string): string {
  const tools = Array.isArray(t.tools) ? t.tools.length : t.tools;
  const cost = t.codexCredits !== undefined ? `${t.codexCredits.toFixed(2)} cr` : t.usd !== undefined ? `$${t.usd.toFixed(3)}` : '';
  return [
    `R${t.round} ${label} ${t.kind}`,
    `${(t.durationMs / 1000).toFixed(0)}s`,
    `in ${kfmt(t.usage.input)} (${kfmt(t.usage.cached)} cached)`,
    `out ${kfmt(t.usage.output)}${t.usage.reasoning ? ` (${kfmt(t.usage.reasoning)} reasoning)` : ''}`,
    `${tools} tools`,
    cost,
    t.verdict ? `verdict ${t.verdict}` : '',
  ].filter(Boolean).join(' · ');
}

function cite(r: CitationResult | undefined): string {
  if (!r) return '';
  return r.status === 'verified' ? '✓' : r.status === 'not_checked' ? '·' : `✗ ${r.status}`;
}

export function renderDebateTurn(t: DebateTurn, seat: string): string {
  const out = [t.answer.trim(), '', `**Verdict:** ${t.verdict} · **confidence:** ${Number.isFinite(t.confidence) ? t.confidence : '?'}`];
  if (t.claims.length) {
    out.push('', '**Claims**');
    for (const c of t.claims) {
      out.push(`- \`${seat}:${c.id}\` [${c.kind}, ${c.confidence}] ${c.text}`);
      for (const e of c.evidence) out.push(`  - ${e.type}: \`${e.ref}\`${e.quote ? ` — "${e.quote}"` : ''}`);
    }
  }
  if (t.stances.length) out.push('', '**Stances**', ...t.stances.map((s) => `- \`${s.claim}\` **${s.stance}** — ${s.reason}`));
  if (t.concessions.length) out.push('', '**Concessions**', ...t.concessions.map((x) => `- ${x}`));
  if (t.open_points.length) out.push('', '**Open points**', ...t.open_points.map((x) => `- ${x}`));
  if (t.assumptions.length) out.push('', '**Assumptions**', ...t.assumptions.map((x) => `- ${x}`));
  return out.join('\n');
}

function roundsTable(rounds: RoundStats[]): string[] {
  const seats = Object.keys(rounds[rounds.length - 1]?.verdicts ?? {});
  return [
    `| round | claims | agreed | partial | disputed | open | withdrawn | citations failed | ${seats.map((s) => `verdict ${s}`).join(' | ')} |`,
    `|---|---|---|---|---|---|---|---|${seats.map(() => '---').join('|')}|`,
    ...rounds.map((r) => `| ${r.round} | ${r.claims} | ${r.agreed} | ${r.partial} | ${r.disputed} | ${r.unaddressed} | ${r.withdrawn} | ${r.citationsFailed}/${r.citationsChecked} | ${seats.map((s) => r.verdicts[s] ?? '').join(' | ')} |`),
  ];
}

export function debateReport(meta: RunMeta, ledger: ClaimLedger, latest: Record<string, DebateTurn>, names: Record<string, string>, stop: string): string {
  const last = ledger.rounds[ledger.rounds.length - 1];
  const out: string[] = [
    `# Debate: ${meta.title}`,
    '',
    `**Outcome:** ${stop} · ${ledger.rounds.length} round(s) · ${last ? `${last.agreed} agreed, ${last.partial} partial, ${last.disputed} disputed, ${last.unaddressed} unaddressed of ${last.claims} claims` : 'no claims'}`,
    '',
    '## Final positions',
  ];
  for (const [seat, t] of Object.entries(latest)) {
    out.push('', `### ${names[seat] ?? seat} — verdict ${t.verdict}, confidence ${Number.isFinite(t.confidence) ? t.confidence : '?'}`, '', t.answer.trim());
  }
  const active = ledger.active();
  const order = { disputed: 0, partial: 1, unaddressed: 2, agreed: 3, withdrawn: 4 };
  const sorted = [...active].sort((a, b) => order[ledger.status(a)] - order[ledger.status(b)]);
  out.push('', '## Claim ledger', '', '| claim | status | kind | citations | stances | text |', '|---|---|---|---|---|---|');
  for (const c of sorted) {
    const stances = Object.entries(c.stances).map(([s, v]) => `${s}:${v.stance}`).join(', ') || '—';
    const cites = c.citations.map(cite).filter(Boolean).join(' ') || '—';
    out.push(`| \`${c.gid}\` | **${ledger.status(c)}** | ${c.kind} | ${cites} | ${stances} | ${c.text.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  const disputed = sorted.filter((c) => ['disputed', 'partial'].includes(ledger.status(c)));
  if (disputed.length) {
    out.push('', '## Disagreements');
    for (const c of disputed) {
      out.push('', `### \`${c.gid}\` (${ledger.status(c)}) ${c.text}`);
      for (const e of c.evidence) out.push(`- evidence (${names[c.owner] ?? c.owner}): \`${e.ref}\`${e.quote ? ` "${e.quote}"` : ''}`);
      for (const [s, v] of Object.entries(c.stances)) if (v.stance !== 'agree') out.push(`- ${names[s] ?? s}: **${v.stance}** — ${v.reason}`);
    }
  }
  const flips = ledger.changedMinds();
  if (flips.length || ledger.concessions.length) {
    out.push('', '## Changed minds');
    for (const f of flips) out.push(`- R${f.round}: ${names[f.seat] ?? f.seat} on \`${f.claim}\`: ${f.from} → ${f.to}`);
    for (const c of ledger.concessions) out.push(`- R${c.round} ${names[c.seat] ?? c.seat} conceded: ${c.text}`);
  }
  out.push('', '## Rounds', '', ...roundsTable(ledger.rounds));
  return out.join('\n');
}

export interface MergedFinding {
  gid: string;
  owner: string;
  f: ReviewTurn['findings'][number];
  location: CitationResult | undefined;
  confirms: { seat: string; reason: string }[];
  rejects: { seat: string; reason: string }[];
  unsure: { seat: string; reason: string }[];
  status: 'consensus' | 'contested' | 'rejected' | 'unreviewed' | 'solo';
}

const SEV: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

function similar(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, A.size + B.size - inter);
}

function span(loc: string): { file: string; lo: number; hi: number } | undefined {
  const m = /^([^:#\s]+)(?:[:#]L?(\d+)(?:[-–]L?(\d+))?)?/.exec(loc.trim().replace(/^`|`$/g, ''));
  if (!m) return undefined;
  const lo = m[2] ? Number(m[2]) : 0;
  return { file: m[1], lo, hi: m[3] ? Number(m[3]) : lo };
}

export interface FindingCluster {
  members: MergedFinding[];
  owners: string[];
  severity: string;
}

/** Group findings that are the same issue (same file, nearby lines, similar title) across reviewers. */
export function clusterFindings(findings: MergedFinding[]): FindingCluster[] {
  const clusters: FindingCluster[] = [];
  for (const m of findings) {
    const s = span(m.f.location);
    const hit = clusters.find((c) =>
      c.members.some((o) => {
        const t = span(o.f.location);
        if (!s || !t || s.file !== t.file || o.owner === m.owner) return false;
        const near = s.lo === 0 || t.lo === 0 || (s.lo <= t.hi + 3 && t.lo <= s.hi + 3);
        return near && similar(o.f.title + ' ' + o.f.problem, m.f.title + ' ' + m.f.problem) >= 0.25;
      }),
    );
    if (hit) {
      hit.members.push(m);
      if (!hit.owners.includes(m.owner)) hit.owners.push(m.owner);
      if ((SEV[m.f.severity] ?? 9) < (SEV[hit.severity] ?? 9)) hit.severity = m.f.severity;
    } else clusters.push({ members: [m], owners: [m.owner], severity: m.f.severity });
  }
  return clusters;
}

function clusterStatus(c: FindingCluster): string {
  const rejects = c.members.reduce((a, m) => a + m.rejects.length, 0);
  const confirms = c.members.reduce((a, m) => a + m.confirms.length, 0);
  if (c.owners.length > 1) return rejects ? `found independently by ${c.owners.join('+')}, contested` : `found independently by ${c.owners.join('+')}`;
  if (rejects && !confirms) return 'rejected by peers';
  if (rejects) return 'contested';
  return c.members[0].status === 'consensus' ? 'confirmed by peers' : c.members[0].status;
}

export function reviewReport(meta: RunMeta, findings: MergedFinding[], summaries: Record<string, ReviewTurn>, names: Record<string, string>): string {
  const clusters = clusterFindings(findings).sort((a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9) || b.owners.length - a.owners.length);
  const out = [`# Review: ${meta.title}`, '', '## Verdicts'];
  for (const [seat, t] of Object.entries(summaries)) out.push(`- **${names[seat] ?? seat}:** ${t.verdict} — ${t.summary}`);
  out.push('', `## Findings (${clusters.length} distinct issue(s) from ${findings.length} finding(s))`, '', '| # | sev | status | location | check | title | ids |', '|---|---|---|---|---|---|---|');
  clusters.forEach((c, i) => {
    const lead = c.members[0];
    const sevs = [...new Set(c.members.map((m) => m.f.severity))].join('/');
    out.push(`| ${i + 1} | ${sevs} | ${clusterStatus(c)} | \`${lead.f.location}\` | ${cite(lead.location)} | ${lead.f.title.replace(/\|/g, '\\|')} | ${c.members.map((m) => `\`${m.gid}\``).join(' ')} |`);
  });
  const sorted = clusters.flatMap((c) => c.members);
  for (const m of sorted) {
    out.push('', `### \`${m.gid}\` [${m.f.severity}] ${m.f.title} — ${m.status}`, '', `- **Where:** \`${m.f.location}\`${m.location && m.location.status !== 'verified' ? ` (location check: ${m.location.status}${m.location.detail ? ', ' + m.location.detail : ''})` : ''}`, `- **Problem:** ${m.f.problem}`, `- **Scenario:** ${m.f.scenario}`, `- **Fix:** ${m.f.fix}`);
    for (const c of m.confirms) out.push(`- ✓ ${names[c.seat] ?? c.seat}: ${c.reason}`);
    for (const r of m.rejects) out.push(`- ✗ ${names[r.seat] ?? r.seat}: ${r.reason}`);
    for (const u of m.unsure) out.push(`- ? ${names[u.seat] ?? u.seat}: ${u.reason}`);
  }
  return out.join('\n');
}

export function usageSection(meta: RunMeta): string {
  const bySeat = new Map<string, { turns: number; ms: number; input: number; cached: number; output: number; reasoning: number; credits: number; usd: number }>();
  for (const t of meta.turns) {
    const s = bySeat.get(t.seat) ?? { turns: 0, ms: 0, input: 0, cached: 0, output: 0, reasoning: 0, credits: 0, usd: 0 };
    s.turns++;
    s.ms += t.durationMs;
    s.input += t.usage.input;
    s.cached += t.usage.cached;
    s.output += t.usage.output;
    s.reasoning += t.usage.reasoning;
    s.credits += t.codexCredits ?? 0;
    s.usd += t.usd ?? 0;
    bySeat.set(t.seat, s);
  }
  const specs = Object.fromEntries(meta.seats.map((s) => [s.role === 'chair' ? 'chair' : s.id, s.spec]));
  const out = ['## Usage', '', '| seat | spec | turns | time | input (cached) | output (reasoning) | cost |', '|---|---|---|---|---|---|---|'];
  for (const [seat, s] of [...bySeat].sort(([a], [b]) => (a === 'chair' ? 1 : b === 'chair' ? -1 : a.localeCompare(b)))) {
    out.push(`| ${seat} | \`${specs[seat] ?? ''}\` | ${s.turns} | ${(s.ms / 1000).toFixed(0)}s | ${kfmt(s.input)} (${kfmt(s.cached)}) | ${kfmt(s.output)} (${kfmt(s.reasoning)}) | ${s.credits ? s.credits.toFixed(2) + ' cr' : ''}${s.usd ? ' ~$' + s.usd.toFixed(3) : ''} |`);
  }
  const q = meta.quota;
  if (q?.after) {
    const line = (label: string, b?: { windows: { label: string; usedPercent: number }[] }, a?: { windows: { label: string; usedPercent: number; resetsAt: number }[] }) =>
      a?.windows.length ? `- ${label}: ${a.windows.map((w) => { const p = b?.windows.find((x) => x.label === w.label); return `${w.label} ${p ? p.usedPercent.toFixed(0) + '% → ' : ''}${w.usedPercent.toFixed(0)}% (resets ${fmtWhen(w.resetsAt)})`; }).join(', ')}` : `- ${label}: unknown`;
    out.push('', line('Codex quota', q.before?.codex, q.after.codex), line('Claude quota', q.before?.claude, q.after.claude));
  }
  return out.join('\n');
}

export function traceTable(meta: RunMeta): string {
  const specs = Object.fromEntries(meta.seats.map((s) => [s.role === 'chair' ? 'chair' : s.id, `${s.engine}:${s.model}@${s.effort ?? '-'}`]));
  const rows = meta.turns.map((t) => [
    String(t.n), `R${t.round}`, t.seat, specs[t.seat] ?? '', t.kind, `${(t.durationMs / 1000).toFixed(0)}s`,
    kfmt(t.usage.input), kfmt(t.usage.cached), kfmt(t.usage.output), kfmt(t.usage.reasoning),
    t.codexCredits !== undefined ? t.codexCredits.toFixed(2) + 'cr' : t.usd !== undefined ? '$' + t.usd.toFixed(3) : '',
    t.verdict ?? '', t.error ? 'ERR' : t.parseError ? 'PARSE' : 'ok',
  ]);
  const head = ['#', 'rnd', 'seat', 'model', 'kind', 'time', 'in', 'cached', 'out', 'reason', 'cost', 'verdict', 'status'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

// ── HTML export ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Small Markdown renderer: headings, lists, code blocks, inline code, bold, tables. */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let i = 0;
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) buf.push(lines[i]);
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (l.startsWith('|') && lines[i + 1]?.startsWith('|---')) {
      const cells = (row: string) => row.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      out.push('<table><thead><tr>' + cells(l).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) out.push('<tr>' + cells(lines[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>');
      out.push('</tbody></table>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      out.push('<ul>');
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]); i++) out.push(`<li${/^\s{2,}/.test(lines[i]) ? ' class="sub"' : ''}>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
      out.push('</ul>');
      continue;
    }
    if (l.trim()) out.push(`<p>${inline(l)}</p>`);
    i++;
  }
  return out.join('\n');
}

export function exportHtml(meta: RunMeta, report: string, turns: { t: RunMeta['turns'][number]; prompt: string; reply: string; thinking?: string; tools?: string }[]): string {
  const turnHtml = turns.map(({ t, prompt, reply, thinking, tools }) => `
<details class="turn"><summary><b>#${t.n} R${t.round} ${esc(t.seat)} · ${esc(t.kind)}</b> <span>${(t.durationMs / 1000).toFixed(0)}s · in ${kfmt(t.usage.input)} (${kfmt(t.usage.cached)} cached) · out ${kfmt(t.usage.output)}${t.verdict ? ' · verdict ' + esc(t.verdict) : ''}${t.error ? ' · <em>error</em>' : ''}</span></summary>
<h4>Reply</h4>${mdToHtml(reply)}
${thinking ? `<details><summary>Reasoning / interim</summary><pre>${esc(thinking)}</pre></details>` : ''}
${tools ? `<details><summary>Tool calls</summary><pre>${esc(tools)}</pre></details>` : ''}
<details><summary>Prompt sent</summary><pre>${esc(prompt)}</pre></details>
</details>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>duo · ${esc(meta.title)}</title>
<style>
:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--card:#fff;--accent:#2f5d8a}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9a9993;--line:#2c2c29;--card:#1c1c1a;--accent:#8db4dc}}
body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif;margin:0 auto;max-width:980px;padding:24px 16px}
h1{font-size:1.5rem}h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid var(--line)}h3{font-size:1.05rem}
code,pre{font-family:ui-monospace,monospace;font-size:.86em}pre{background:var(--card);border:1px solid var(--line);padding:10px;overflow-x:auto;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}td,th{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.turn{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:8px 0}.turn summary span{color:var(--muted)}
.meta{color:var(--muted)}li.sub{margin-left:1.5em}a{color:var(--accent)}
</style></head><body>
<h1>${esc(meta.title)}</h1>
<p class="meta">${esc(meta.id)} · ${esc(meta.protocol)} · ${esc(meta.status)} · ${esc(meta.createdAt)} · cwd <code>${esc(meta.cwd)}</code>${meta.git?.head ? ` · git <code>${esc(meta.git.head.slice(0, 10))}${meta.git.dirty ? '+dirty' : ''}</code>` : ''}</p>
<p class="meta">${meta.seats.map((s) => `${esc(s.role === 'chair' ? 'chair' : s.id)}=<code>${esc(s.spec)}</code>`).join(' · ')} · codex ${esc(meta.versions.codex ?? '')} · claude ${esc(meta.versions.claude ?? '')}</p>
<h2>Brief</h2><pre>${esc(meta.prompt)}</pre>
${mdToHtml(report)}
<h2>Turns</h2>
${turnHtml}
</body></html>`;
}
