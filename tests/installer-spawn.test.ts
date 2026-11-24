import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: exec }));

import { defaultHasGlobalBin, defaultInstallGlobal } from '../src/installer.js';

describe('installer default spawns', () => {
  beforeEach(() => {
    exec.mockReset();
    exec.mockReturnValue('');
  });

  it('should_probe_the_global_bin_from_the_home_dir_so_the_current_dir_never_wins_the_lookup', () => {
    expect(defaultHasGlobalBin()).toBe(true);
    const [, args, options] = exec.mock.calls[0];
    expect(args).toEqual(['lumira']);
    expect(options.cwd).toBe(homedir());
    expect(options.shell).toBeUndefined();
  });

  it('should_report_a_missing_global_bin_when_the_probe_fails', () => {
    exec.mockImplementation(() => { throw new Error('not found'); });
    expect(defaultHasGlobalBin()).toBe(false);
  });

  it('should_install_globally_from_the_home_dir_without_a_shell', () => {
    expect(defaultInstallGlobal()).toBe(true);
    const [cmd, args, options] = exec.mock.calls[0];
    expect(cmd).toBe('npm');
    expect(args).toEqual(['install', '-g', 'lumira']);
    expect(options.cwd).toBe(homedir());
    expect(options.shell).toBeUndefined();
    expect(options.timeout).toBe(120000);
  });

  it('should_report_a_failed_global_install', () => {
    exec.mockImplementation(() => { throw new Error('EACCES'); });
    expect(defaultInstallGlobal()).toBe(false);
  });
});
