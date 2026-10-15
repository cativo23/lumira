import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGitStatus } from '../../src/parsers/git.js';
import { EMPTY_GIT } from '../../src/types.js';
import * as cacheUtils from '../../src/utils/cache.js';

// Clear cache before each test to avoid stale data
beforeEach(() => {
  vi.resetModules();
});

describe('parseGitStatus', () => {
  it('parses branch and porcelain output', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('M  file.ts\n?? new.ts\nA  added.ts');
    const result = await parseGitStatus('/test', exec);
    expect(result.branch).toBe('main');
    expect(result.staged).toBe(2);
    expect(result.modified).toBe(0);
    expect(result.untracked).toBe(1);
  });

  it('counts MM as both staged and modified', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce('dev')
      .mockResolvedValueOnce('MM file.ts\nA  added.ts\n M only-worktree.ts\nD  deleted.ts\n?? new.ts');
    const result = await parseGitStatus('/test2', exec);
    expect(result.staged).toBe(3);
    expect(result.modified).toBe(2);
    expect(result.untracked).toBe(1);
  });

  it('counts an unstaged change as modified when it is the first status line of a real repo', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'lumira-git-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo });
      git('init', '-q');
      writeFileSync(join(repo, 'a.ts'), 'a\n');
      git('add', 'a.ts');
      git('commit', '-qm', 'init');
      appendFileSync(join(repo, 'a.ts'), 'b\n');

      const result = await parseGitStatus(repo);
      expect(result.staged).toBe(0);
      expect(result.modified).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns empty on empty branch', async () => {
    const exec = vi.fn().mockResolvedValue('');
    expect(await parseGitStatus('/not-a-repo', exec)).toEqual(EMPTY_GIT);
  });

  it('handles no changes', async () => {
    const exec = vi.fn().mockResolvedValueOnce('feature/test').mockResolvedValueOnce('');
    const result = await parseGitStatus('/clean', exec);
    expect(result.branch).toBe('feature/test');
    expect(result.staged).toBe(0);
  });


  it('ignores whitespace-only status output', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('   \n  ');
    const result = await parseGitStatus('/test-ws', exec);
    expect(result.staged).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.untracked).toBe(0);
  });

  it('cache key uses full MD5 digest (32 hex chars) to prevent birthday collisions', async () => {
    // Force a cache miss so the write path always runs — otherwise a fresh
    // on-disk TTL entry from a prior `vitest run` (within GIT_CACHE_TTL) makes
    // parseGitStatus return early and writeTtlCache is never called (flaky).
    const readSpy = vi.spyOn(cacheUtils, 'readTtlCache').mockReturnValue(null);
    // Spy on writeTtlCache to capture the key the production code actually uses.
    // If someone truncates the digest or changes the algorithm in git.ts, the
    // captured key will no longer match the expected 32-char hex pattern.
    const writeSpy = vi.spyOn(cacheUtils, 'writeTtlCache');
    const exec = vi.fn()
      .mockResolvedValueOnce('main')
      .mockResolvedValueOnce('');

    const testPath = '/cache-key-test';
    await parseGitStatus(testPath, exec);

    expect(writeSpy).toHaveBeenCalledOnce();
    const usedKey: string = writeSpy.mock.calls[0][0];

    const expectedDigest = createHash('md5').update(testPath).digest('hex');
    expect(usedKey).toBe(`git-${expectedDigest}`);
    // Full 32-char hex digest — not truncated
    expect(usedKey).toMatch(/^git-[0-9a-f]{32}$/);

    writeSpy.mockRestore();
    readSpy.mockRestore();
  });

});
