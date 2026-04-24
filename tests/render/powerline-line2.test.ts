import { describe, it, expect } from 'vitest';
import { renderPowerlineLine2 } from '../../src/render/powerline-line2.js';
import { createColors } from '../../src/render/colors.js';
import { stripAnsi } from '../../src/render/colors.js';
import { resolveIcons } from '../../src/render/icons.js';
import { normalize } from '../../src/normalize.js';
import { DEFAULT_CONFIG, DEFAULT_DISPLAY, EMPTY_GIT, EMPTY_TRANSCRIPT } from '../../src/types.js';
import type { RenderContext } from '../../src/types.js';

function makeCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  const rawInput = {
    model: 'Claude Sonnet 4.6',
    session_id: 'test',
    context_window: { used_percentage: 42, remaining_percentage: 58, total_input_tokens: 12000, total_output_tokens: 1800 },
    cost: { total_cost_usd: 0.42, total_duration_ms: 185000 },
  };
  return {
    input: normalize(rawInput),
    git: { ...EMPTY_GIT },
    transcript: { ...EMPTY_TRANSCRIPT },
    tokenSpeed: null,
    memory: null,
    gsd: null,
    mcp: null,
    cols: 120,
    config: { ...DEFAULT_CONFIG, display: { ...DEFAULT_DISPLAY } },
    icons: resolveIcons('nerd'),
    ...overrides,
  };
}

const c = createColors('truecolor', null);

describe('renderPowerlineLine2', () => {
  it('renders context bar segment in truecolor', () => {
    const ctx = makeCtx();
    const out = renderPowerlineLine2(ctx, 'truecolor', null, c);
    expect(out).toBeTruthy();
    expect(out).toContain('\x1b[48;2;');
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });

  it('renders cost segment when cost is present', () => {
    const ctx = makeCtx();
    const out = stripAnsi(renderPowerlineLine2(ctx, 'truecolor', null, c));
    expect(out).toContain('$');
  });

  it('returns empty string when all display toggles are off', () => {
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        display: { ...DEFAULT_DISPLAY, contextBar: false, contextTokens: false, cost: false, duration: false, rateLimits: false },
      },
    });
    const out = renderPowerlineLine2(ctx, 'truecolor', null, c);
    expect(out).toBe('');
  });

  it('projects to 256-color escapes in 256 mode', () => {
    const ctx = makeCtx();
    const out = renderPowerlineLine2(ctx, '256', null, c);
    expect(out).toMatch(/\x1b\[48;5;\d+m/);
    expect(out).not.toContain('\x1b[48;2;');
  });
});
