import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: exec }));

import { detectCcVersion } from '../src/cc-version.js';

describe('detectCcVersion default runner', () => {
  beforeEach(() => {
    exec.mockReset();
    exec.mockReturnValue('2.1.331 (Claude Code)\n');
  });

  it('should_run_claude_version_without_a_shell', () => {
    expect(detectCcVersion()).toBe('2.1.331');
    const [cmd, args, options] = exec.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['--version']);
    expect(options.shell).toBeUndefined();
  });

  it('should_run_from_the_home_dir_so_the_current_dir_never_wins_the_lookup', () => {
    detectCcVersion();
    expect(exec.mock.calls[0][2].cwd).toBe(homedir());
  });

  it('should_bound_the_call_with_a_timeout', () => {
    detectCcVersion();
    expect(exec.mock.calls[0][2].timeout).toBe(3000);
  });

  it('should_treat_a_failed_spawn_as_an_unknown_version', () => {
    exec.mockImplementation(() => { throw new Error('spawn claude ENOENT'); });
    expect(detectCcVersion()).toBeUndefined();
  });
});
