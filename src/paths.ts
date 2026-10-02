import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configHome, dataHome, IS_MAC, IS_WIN } from './platform.ts';

const home = homedir();

/** Root of the duo checkout (bin/, src/, node_modules/). The bundled engine sets DUO_ROOT. */
export const PROJECT_ROOT = process.env.DUO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything duo writes: runs, chats, worktrees, caches. Override with DUO_HOME. */
export const DUO_HOME = process.env.DUO_HOME || join(dataHome(), 'duo');
export const RUNS_DIR = join(DUO_HOME, 'runs');
export const CACHE_DIR = join(DUO_HOME, 'cache');
export const WORKTREES_DIR = join(DUO_HOME, 'worktrees');
export const SCRATCH_DIR = join(DUO_HOME, 'scratch');
export const CLAW_LEDGER_DIR = join(DUO_HOME, 'claw', 'runs');
export const CLAW_WF_DIR = join(DUO_HOME, 'claw', 'wf');

/** ~/.config/duo/config.json on Linux; next to the data on macOS and Windows. Override with DUO_CONFIG. */
export const CONFIG_PATH = process.env.DUO_CONFIG || join(IS_WIN || IS_MAC ? DUO_HOME : join(configHome(), 'duo'), 'config.json');

export const CODEX_HOME = process.env.CODEX_HOME || join(home, '.codex');
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
