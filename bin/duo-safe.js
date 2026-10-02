#!/usr/bin/env node
// Restricted entry point for callers that are auto-approved (the Codex allow-rule): no raw Codex
// config passthrough (cfg:), no WebFetch.
process.env.DUO_SAFE = '1';
await import('../src/cli.ts');
