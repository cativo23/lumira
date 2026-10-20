import { describe, it, expect } from 'vitest';
import { renderLine4 } from '../../src/render/line4.js';
import { createColors, stripAnsi } from '../../src/render/colors.js';
import { EMPTY_GIT, EMPTY_TRANSCRIPT, DEFAULT_CONFIG, DEFAULT_DISPLAY } from '../../src/types.js';
import type { ClaudeCodeInput, GsdInfo, RenderContext } from '../../src/types.js';
import { NERD_ICONS } from '../../src/render/icons.js';
import { normalize } from '../../src/normalize.js';
import { displayWidth, safeCols } from '../../src/render/text.js';

const c = createColors('named');

const baseInput: ClaudeCodeInput = {
  model: 'Claude Opus 4',
  session_id: 'test-123',
  context_window: { used_percentage: 50, remaining_percentage: 50 },
  cost: { total_cost_usd: 1.0, total_duration_ms: 60000 },
  workspace: { current_dir: '/home/user/project' },
};

function makeCtx(gsd: GsdInfo | null, overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    input: normalize(baseInput), git: EMPTY_GIT, transcript: EMPTY_TRANSCRIPT,
    tokenSpeed: null, memory: null, gsd, mcp: null, cols: 120,
    config: { ...DEFAULT_CONFIG, display: { ...DEFAULT_DISPLAY } },
    icons: NERD_ICONS,
    ...overrides,
  };
}

describe('renderLine4', () => {
  it('returns empty string when gsd is null', () => {
    expect(renderLine4(makeCtx(null), c)).toBe('');
  });

  it('returns empty string when no task and no update', () => {
    expect(renderLine4(makeCtx({ currentTask: undefined, updateAvailable: false }), c)).toBe('');
  });

  it('shows current task', () => {
    const out = stripAnsi(renderLine4(makeCtx({ currentTask: 'Fix critical bug' }), c));
    expect(out).toContain('GSD');
    expect(out).toContain('Fix critical bug');
  });

  // Update indicator mirrors GSD's own statusline text (`⬆ /gsd:update`) and
  // renders even without a current task — so a GSD update is visible in ANY
  // project, whether or not it has a .planning/STATE.md.
  it('shows the GSD update indicator with no task (global)', () => {
    const out = stripAnsi(renderLine4(makeCtx({ updateAvailable: true }), c));
    expect(out).toContain('/gsd:update');
  });

  it('shows both task and update indicator', () => {
    const out = stripAnsi(renderLine4(makeCtx({ currentTask: 'My task', updateAvailable: true }), c));
    expect(out).toContain('My task');
    expect(out).toContain('/gsd:update');
  });

  it('shows the stale-hooks warning', () => {
    const out = stripAnsi(renderLine4(makeCtx({ staleHooks: true }), c));
    expect(out).toContain('stale hooks');
    expect(out).toContain('/gsd:update');
  });

  it('shows the dev-install warning instead of stale-hooks when devInstall is set', () => {
    const out = stripAnsi(renderLine4(makeCtx({ staleHooks: true, devInstall: true }), c));
    expect(out).toContain('dev install');
    expect(out).not.toContain('stale hooks');
  });

  it('renders progress-bar scene content carried in currentTask', () => {
    const out = stripAnsi(renderLine4(makeCtx({ currentTask: 'v2.0 Automation █████░░░░░ 50%' }), c));
    expect(out).toContain('█████░░░░░ 50%');
  });

  // ── Custom commands (issue #143 phase 3) ─────────────────────────
  describe('custom commands', () => {
    it('renders custom commands on line 4 even when GSD is null', () => {
      const ctx = makeCtx(null, {
        customCommands: [{ id: 'foo', text: 'WIDGET4', state: 'ok', line: 4, ansi: false }],
      });
      const out = stripAnsi(renderLine4(ctx, c));
      expect(out).toContain('WIDGET4');
    });

    it('renders custom commands alongside GSD task', () => {
      const ctx = makeCtx({ currentTask: 'task' }, {
        customCommands: [{ id: 'foo', text: 'BOTH', state: 'ok', line: 4, ansi: false }],
      });
      const out = stripAnsi(renderLine4(ctx, c));
      expect(out).toContain('task');
      expect(out).toContain('BOTH');
    });

    it('ignores commands for other lines', () => {
      const ctx = makeCtx(null, {
        customCommands: [{ id: 'foo', text: 'WRONG', state: 'ok', line: 1, ansi: false }],
      });
      expect(renderLine4(ctx, c)).toBe('');
    });

    it('drops hidden state outputs', () => {
      const ctx = makeCtx(null, {
        customCommands: [{ id: 'foo', text: 'GONE', state: 'hidden', line: 4, ansi: false }],
      });
      expect(renderLine4(ctx, c)).toBe('');
    });

    it('returns empty string when neither GSD nor custom commands have content', () => {
      const ctx = makeCtx(null, { customCommands: [] });
      expect(renderLine4(ctx, c)).toBe('');
    });
  });
});

describe('renderLine4 — fitting the terminal width', () => {
  const longTask = 'Implement the priority based eviction for the classic statusline renderer';
  const gsd: GsdInfo = { currentTask: longTask, hasResume: true, updateAvailable: true, staleHooks: true };
  const widget = [{ id: 'w', text: 'WIDGET', state: 'ok' as const, line: 4 as const, ansi: false }];
  const render = (cols: number) => stripAnsi(renderLine4(makeCtx(gsd, { cols, customCommands: widget }), c));

  it('is unchanged when everything fits', () => {
    const out = render(300);
    expect(out).toContain(longTask.slice(0, 40));
    expect(out).toContain('WIDGET');
  });

  it.each([60, 80, 100, 120])('never exceeds the usable width at %i cols when the warnings fit', (cols) => {
    expect(displayWidth(render(cols))).toBeLessThanOrEqual(safeCols(cols));
  });

  it('drops custom widgets before shortening the task, and always keeps the warnings', () => {
    // 121 cells with the widget, 114 without: at 122 cols (118 usable) only the widget goes.
    const out = render(122);
    expect(out).not.toContain('WIDGET');
    expect(out).toContain('Implement the priority based eviction');
    expect(out).toContain('⬆ /gsd:update');
    expect(out).toContain('stale hooks');
  });

  it('keeps the update and stale-hooks warnings even at 80 cols', () => {
    const out = render(80);
    expect(out).toContain('⬆ /gsd:update');
    expect(out).toContain('stale hooks');
    expect(out).toContain('GSD');
  });
});

describe('renderLine4 — warnings on a narrow terminal', () => {
  it.each([
    [false, 40], [false, 50], [true, 40], [true, 56], [true, 60], [true, 66],
  ])('compacts the warnings (devInstall %s) to fit %i cols, never dropping them', (devInstall, cols) => {
    const gsd: GsdInfo = { updateAvailable: true, staleHooks: true, devInstall, hasResume: true };
    const out = stripAnsi(renderLine4(makeCtx(gsd, { cols }), c));
    expect(displayWidth(out)).toBeLessThanOrEqual(safeCols(cols));
    expect(out).toContain('⬆ /gsd:update');
    expect(out).toContain(devInstall ? '⚠ dev install' : '⚠ stale hooks');
  });

  it('keeps the full warning text when it fits', () => {
    const gsd: GsdInfo = { updateAvailable: true, staleHooks: true, devInstall: true };
    expect(stripAnsi(renderLine4(makeCtx(gsd, { cols: 120 }), c))).toContain('re-run installer to sync hooks');
  });
});

describe('renderLine4 — task vs warning wording', () => {
  it('keeps the task and uses the short warning when only that fits', () => {
    const gsd: GsdInfo = { currentTask: 'Long GSD task here', updateAvailable: true, staleHooks: true, devInstall: true, hasResume: true };
    const out = stripAnsi(renderLine4(makeCtx(gsd, { cols: 66 }), c));
    expect(displayWidth(out)).toBeLessThanOrEqual(safeCols(66));
    expect(out).toContain('Long GSD task here');
    expect(out).toContain('⚠ dev install');
    expect(out).not.toContain('re-run installer');
  });
});
