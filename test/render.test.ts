import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtTurnLine, mdToHtml } from '../src/render.ts';

test('markdown to html: headings, tables, code, escaping', () => {
  const html = mdToHtml('# T\n\n| a | b |\n|---|---|\n| `x` | **y** |\n\n```\n<script>\n```\n- item <b>');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<td><code>x<\/code><\/td><td><strong>y<\/strong><\/td>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<li>item &lt;b&gt;<\/li>/);
  assert.doesNotMatch(html, /<script>/);
});

test('turn line', () => {
  const line = fmtTurnLine({ round: 2, kind: 'critique', durationMs: 42_000, usage: { input: 38200, cached: 31000, output: 2100, reasoning: 600 }, codexCredits: 1.92, tools: 3, verdict: 'partial' }, 'A codex:gpt-6-sol@high');
  assert.equal(line, 'R2 A codex:gpt-6-sol@high critique · 42s · in 38.2K (31.0K cached) · out 2.1K (600 reasoning) · 3 tools · 1.92 cr · verdict partial');
});
