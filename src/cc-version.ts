import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { semverCompare } from './utils/semver.js';

/** Claude Code removed the `subagentStatusLine` setting in this release. */
export const CC_DROPPED_SUBAGENT_STATUSLINE = '2.1.323';

/**
 * First Claude Code release where the `lumira-agentrow` mod is known to work.
 * Keep it equal to `engines["claude-code"]` in the mod's plugin.json (a test
 * checks). `AgentRow` is not in Claude Code's changelog, so this is the oldest
 * version it was seen working on; lower it only after trying an older one.
 */
export const MIN_CC_MODS = '2.1.330';

export const MOD_INSTALL_COMMAND = 'claude plugin install lumira-agentrow --marketplace cativo23/lumira';

export type SubagentPanel =
  /** `subagentStatusLine` still exists: the `lumira subagent` command can be registered. */
  | 'statusline'
  /** The setting is gone but the mod needs a newer Claude Code. */
  | 'too-old-for-mod'
  /** The mod is the way to customize agent rows. */
  | 'mod'
  /** The version could not be read. */
  | 'unknown';

export function parseCcVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+/.exec(output)?.[0];
}

export function subagentPanel(version: string | undefined): SubagentPanel {
  if (version === undefined) return 'unknown';
  if (semverCompare(version, CC_DROPPED_SUBAGENT_STATUSLINE) < 0) return 'statusline';
  if (semverCompare(version, MIN_CC_MODS) < 0) return 'too-old-for-mod';
  return 'mod';
}

// Spawned from the home dir, not the current one: on Windows the current
// directory is searched before PATH, so running `lumira install` inside a
// downloaded folder holding a `claude.exe` would otherwise run that file.
function defaultRun(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
    cwd: homedir(),
  });
}

/**
 * Ask the `claude` on PATH for its version. Any failure (not installed, not on
 * PATH, a Windows `.cmd` shim that execFile cannot start, a timeout) is
 * "unknown", never an error: the installer must work without it.
 */
export function detectCcVersion(run: (cmd: string, args: string[]) => string = defaultRun): string | undefined {
  try {
    return parseCcVersion(run('claude', ['--version']));
  } catch {
    return undefined;
  }
}
