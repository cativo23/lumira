import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ROW_OPTIONS,
  compactTokens,
  configFile,
  formatDuration,
  formatRow,
  parseConfig,
  pickHome,
  resolveRowOptions,
  shortModel,
  type AgentView,
} from '../../plugins/lumira-agentrow/hooks/row.js';

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

const running: AgentView = {
  type: 'general-purpose',
  model: 'claude-haiku-5-5',
  effort: 'high',
  description: 'Scan the repo',
  taskStatus: 'running',
  startTime: 1_000_000,
  cost: { usd: 0.0512 },
  contextWindowSize: 1_000_000,
  tokenCount: 110_000,
  tokenSamples: [10_000, 40_000, 80_000, 110_000],
};

const NOW = 1_000_000 + 72_000;

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [-5000, '0s'],
    [5_000, '5s'],
    [59_999, '59s'],
    [60_000, '1m00s'],
    [72_000, '1m12s'],
    [3_599_000, '59m59s'],
    [3_661_000, '1h01m'],
  ])('should_format_%ims_as_%s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('compactTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1k'],
    [110_000, '110k'],
    [999_499, '999k'],
    [999_500, '1.0M'],
    [999_999, '1.0M'],
    [1_000_000, '1.0M'],
    [1_500_000, '1.5M'],
  ])('should_compact_%i_as_%s', (n, expected) => {
    expect(compactTokens(n)).toBe(expected);
  });
});

describe('shortModel', () => {
  it('should_reduce_a_claude_model_id_to_its_family', () => {
    expect(shortModel('claude-haiku-5-5')).toBe('haiku');
    expect(shortModel('claude-opus-4-8[1m]')).toBe('opus');
  });

  it('should_leave_a_non_claude_model_untouched', () => {
    expect(shortModel('gpt-4o')).toBe('gpt-4o');
  });
});

describe('formatRow', () => {
  it('should_show_type_model_effort_description_elapsed_cost_context_and_status_for_a_running_agent', () => {
    const text = strip(formatRow(running, DEFAULT_ROW_OPTIONS, NOW));
    expect(text).toContain('general-purpose');
    expect(text).toContain('haiku');
    expect(text).toContain('high');
    expect(text).toContain('Scan the repo');
    expect(text).toContain('1m12s');
    expect(text).toContain('$0.05');
    expect(text).toContain('110k/1.0M 11%');
    expect(text).toContain('running');
  });

  it('should_not_draw_the_sparkline_by_default', () => {
    expect(strip(formatRow(running, DEFAULT_ROW_OPTIONS, NOW))).not.toMatch(/[▁▂▃▄▅▆▇█]/);
  });

  it('should_draw_the_sparkline_when_enabled_for_a_running_agent', () => {
    const text = strip(formatRow(running, { ...DEFAULT_ROW_OPTIONS, sparkline: true }, NOW));
    expect(text).toMatch(/[▁▂▃▄▅▆▇█]{4}/);
    expect(text).toContain('█');
  });

  it('should_skip_the_sparkline_with_fewer_than_two_samples_or_no_growth', () => {
    const opts = { ...DEFAULT_ROW_OPTIONS, sparkline: true };
    expect(strip(formatRow({ ...running, tokenSamples: [5] }, opts, NOW))).not.toMatch(/[▁-█]/);
    expect(strip(formatRow({ ...running, tokenSamples: [0, 0, 0] }, opts, NOW))).not.toMatch(/[▁-█]/);
  });

  it('should_hide_elapsed_and_sparkline_once_the_agent_is_not_running', () => {
    const done: AgentView = { ...running, taskStatus: 'completed' };
    const text = strip(formatRow(done, { ...DEFAULT_ROW_OPTIONS, sparkline: true }, NOW));
    expect(text).not.toContain('1m12s');
    expect(text).not.toMatch(/[▁-█]/);
    expect(text).toContain('completed');
  });

  it('should_omit_cost_when_the_engine_has_none', () => {
    const text = strip(formatRow({ ...running, cost: undefined }, DEFAULT_ROW_OPTIONS, NOW));
    expect(text).not.toContain('$');
  });

  it('should_fall_back_to_a_plain_token_count_without_a_context_window', () => {
    const text = strip(formatRow({ ...running, contextWindowSize: undefined }, DEFAULT_ROW_OPTIONS, NOW));
    expect(text).toContain('110k tok');
    expect(text).not.toContain('%');
  });

  it('should_omit_model_and_effort_when_the_agent_has_neither', () => {
    const text = strip(formatRow({ ...running, model: undefined, effort: undefined }, DEFAULT_ROW_OPTIONS, NOW));
    expect(text).toContain('general-purpose');
    expect(text).not.toContain('haiku');
    expect(text).not.toContain('high');
  });

  it('should_render_a_numeric_effort', () => {
    const text = strip(formatRow({ ...running, effort: 8000 }, DEFAULT_ROW_OPTIONS, NOW));
    expect(text).toContain('8000');
  });

  it.each([
    ['type', 'general-purpose'],
    ['effort', 'high'],
    ['elapsed', '1m12s'],
    ['cost', '$0.05'],
    ['context', '110k/1.0M'],
  ] as const)('should_hide_%s_when_its_toggle_is_off', (key, fragment) => {
    const text = strip(formatRow(running, { ...DEFAULT_ROW_OPTIONS, [key]: false }, NOW));
    expect(text).not.toContain(fragment);
    expect(text).toContain('Scan the repo');
    expect(text).toContain('running');
  });

  it.each([
    [10, 32],
    [59, 32],
    [60, 33],
    [84, 33],
    [85, 31],
    [100, 31],
  ])('should_color_context_%i_percent_with_sgr_%i', (pct, code) => {
    const agent: AgentView = { ...running, tokenCount: pct * 10_000, contextWindowSize: 1_000_000 };
    const raw = formatRow(agent, DEFAULT_ROW_OPTIONS, NOW);
    expect(raw).toContain(`\u001b[${code}m${pct}%\u001b[0m`);
  });

  it.each([
    ['running', 36],
    ['completed', 32],
    ['failed', 31],
    ['killed', 33],
  ] as const)('should_color_the_%s_status_with_sgr_%i', (taskStatus, code) => {
    const raw = formatRow({ ...running, taskStatus }, DEFAULT_ROW_OPTIONS, NOW);
    expect(raw).toContain(`\u001b[${code}m${taskStatus}\u001b[0m`);
  });

  it('should_dim_an_unknown_future_status_without_an_icon', () => {
    const raw = formatRow({ ...running, taskStatus: 'zombie' }, DEFAULT_ROW_OPTIONS, NOW);
    expect(raw).toContain('\u001b[2mzombie\u001b[0m');
  });

  it('should_use_ascii_icons_when_ascii_mode_is_on', () => {
    const opts = { ...DEFAULT_ROW_OPTIONS, ascii: true };
    expect(strip(formatRow(running, opts, NOW))).toMatch(/^\* /);
    expect(strip(formatRow({ ...running, taskStatus: 'completed' }, opts, NOW))).toMatch(/^\+ /);
    expect(strip(formatRow({ ...running, taskStatus: 'failed' }, opts, NOW))).toMatch(/^! /);
  });

  it('should_use_glyph_icons_by_default', () => {
    expect(strip(formatRow(running, DEFAULT_ROW_OPTIONS, NOW))).toMatch(/^◔ /);
    expect(strip(formatRow({ ...running, taskStatus: 'completed' }, DEFAULT_ROW_OPTIONS, NOW))).toMatch(/^✔ /);
  });

  it('should_strip_control_characters_from_the_description', () => {
    const raw = formatRow({ ...running, description: 'hi\u001b]0;pwned\u0007there\nnext' }, DEFAULT_ROW_OPTIONS, NOW);
    expect(raw).not.toContain('\u0007');
    expect(raw).not.toContain('\u001b]');
    expect(raw).not.toContain('\n');
  });
});

describe('resolveRowOptions', () => {
  it.each([undefined, null, 42, 'x', [], {}])('should_return_defaults_for_%j', (raw) => {
    expect(resolveRowOptions(raw)).toEqual(DEFAULT_ROW_OPTIONS);
  });

  it('should_default_everything_on_except_the_sparkline', () => {
    expect(DEFAULT_ROW_OPTIONS).toEqual({
      type: true, effort: true, elapsed: true, cost: true, context: true, sparkline: false, ascii: false,
    });
  });

  it('should_apply_only_the_booleans_the_user_set', () => {
    const o = resolveRowOptions({ subagentRow: { cost: false, sparkline: true } });
    expect(o).toEqual({ ...DEFAULT_ROW_OPTIONS, cost: false, sparkline: true });
  });

  it('should_ignore_non_boolean_values_and_unknown_keys', () => {
    const o = resolveRowOptions({ subagentRow: { cost: 'no', type: 0, effort: null, bogus: false, ascii: true } });
    expect(o).toEqual(DEFAULT_ROW_OPTIONS);
  });

  it('should_ignore_a_subagentRow_that_is_not_an_object', () => {
    expect(resolveRowOptions({ subagentRow: [true] })).toEqual(DEFAULT_ROW_OPTIONS);
    expect(resolveRowOptions({ subagentRow: 'cost' })).toEqual(DEFAULT_ROW_OPTIONS);
  });

  it('should_turn_ascii_mode_on_when_lumira_icons_is_none', () => {
    expect(resolveRowOptions({ icons: 'none' }).ascii).toBe(true);
    expect(resolveRowOptions({ icons: 'nerd' }).ascii).toBe(false);
    expect(resolveRowOptions({ icons: 'emoji' }).ascii).toBe(false);
  });

  it('should_not_let_the_subagentRow_block_set_ascii_directly', () => {
    expect(resolveRowOptions({ subagentRow: { ascii: true } }).ascii).toBe(false);
  });

  it('should_not_be_polluted_by_a_proto_key', () => {
    const raw = JSON.parse('{"subagentRow": {"__proto__": {"cost": false}}}');
    expect(resolveRowOptions(raw)).toEqual(DEFAULT_ROW_OPTIONS);
    expect(({} as Record<string, unknown>).cost).toBeUndefined();
  });
});

describe('pickHome', () => {
  it('should_prefer_userprofile_on_windows', () => {
    expect(pickHome('windows', 'C:\\msys\\home\\x', 'C:\\Users\\x')).toBe('C:\\Users\\x');
  });

  it('should_fall_back_to_home_on_windows_when_userprofile_is_unset', () => {
    expect(pickHome('windows', 'C:\\Users\\x', undefined)).toBe('C:\\Users\\x');
  });

  it.each(['linux', 'macos', 'wsl', 'unknown', undefined])('should_prefer_home_on_%s', (platform) => {
    expect(pickHome(platform, '/home/x', '/other')).toBe('/home/x');
  });

  it('should_fall_back_to_userprofile_when_home_is_unset_off_windows', () => {
    expect(pickHome('linux', undefined, '/home/x')).toBe('/home/x');
  });

  it('should_treat_empty_strings_as_unset', () => {
    expect(pickHome('linux', '', '/home/x')).toBe('/home/x');
    expect(pickHome('windows', 'C:\\Users\\x', '')).toBe('C:\\Users\\x');
  });

  it('should_return_undefined_when_nothing_is_set', () => {
    expect(pickHome('linux', undefined, undefined)).toBeUndefined();
    expect(pickHome('windows', '', '')).toBeUndefined();
  });
});

describe('configFile', () => {
  it('should_point_at_lumiras_own_config_under_the_home_dir', () => {
    expect(configFile('/home/x')).toBe('/home/x/.config/lumira/config.json');
  });

  it('should_not_double_the_separator_for_a_trailing_slash_or_backslash', () => {
    expect(configFile('/home/x/')).toBe('/home/x/.config/lumira/config.json');
    expect(configFile('C:\\Users\\x\\')).toBe('C:\\Users\\x/.config/lumira/config.json');
  });
});

describe('parseConfig', () => {
  it('should_parse_valid_json', () => {
    expect(parseConfig('{"icons":"none"}')).toEqual({ icons: 'none' });
  });

  it.each(['', '{', 'not json', '   '])('should_return_undefined_for_unparseable_text_%j', (text) => {
    expect(parseConfig(text)).toBeUndefined();
  });

  it('should_feed_resolveRowOptions_safely_when_the_file_is_garbage', () => {
    expect(resolveRowOptions(parseConfig('{'))).toEqual(DEFAULT_ROW_OPTIONS);
  });
});
