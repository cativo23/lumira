import { describe, it, expect, vi } from 'vitest';
import { register } from '../../plugins/lumira-agentrow/hooks/register.js';

type Next = (e: unknown) => unknown;
type Hook = ($: unknown, e: unknown, next: Next) => Promise<{ props: { body?: string } }>;

interface World {
  now: number;
  platform?: string;
  env: Record<string, string | undefined>;
  files: Record<string, { mtimeMs: number; text: string }>;
  unreadable: Set<string>;
  stats: string[];
  reads: string[];
}

const HOME = '/home/x';
const CONFIG = `${HOME}/.config/lumira/config.json`;

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

const world = (over: Partial<World> = {}): World => ({
  now: 0,
  platform: 'linux',
  env: { HOME },
  files: {},
  unreadable: new Set(),
  stats: [],
  reads: [],
  ...over,
});

const agent = {
  id: 'a1',
  type: 'general-purpose',
  model: 'claude-haiku-5-5',
  description: 'Scan the repo',
  taskStatus: 'running',
  startTime: 1_000_000,
  cost: { usd: 0.0512 },
  contextWindowSize: 1_000_000,
  tokenCount: 110_000,
  tokenSamples: [10_000, 110_000],
  rowIds: ['a1'],
  isHidden: false,
};

function boot(w: World) {
  let hook: Hook | undefined;
  const on = (event: string, _matcher: unknown, fn: Hook) => {
    if (event === 'ui.render') hook = fn;
  };
  register(on as never);

  const $ = {
    clock: { now: async () => w.now },
    session: { info: async () => ({ platform: w.platform }) },
    env: { get: async (name: string) => w.env[name] },
    fs: {
      stat: async (path: string) => {
        w.stats.push(path);
        const file = w.files[path];
        if (!file) throw new Error('ENOENT');
        return { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false };
      },
      read: async (path: string) => {
        w.reads.push(path);
        if (w.unreadable.has(path)) throw new Error('EIO');
        return w.files[path]?.text ?? '';
      },
    },
  };

  const next = vi.fn((e: unknown) => e);
  const row = async (props: Record<string, unknown> = {}) => {
    const merged = Object.defineProperties({ ...agent }, Object.getOwnPropertyDescriptors(props));
    const out = await hook!($, { component: 'AgentRow', props: merged }, next);
    return out as { props: Record<string, unknown> };
  };
  const body = async (props: Record<string, unknown> = {}) => String((await row(props)).props.body ?? '');
  return { body, row, next };
}

describe('lumira-agentrow register', () => {
  it('should_hook_ui_render_on_agent_rows_only', () => {
    const calls: Array<[string, unknown]> = [];
    register(((event: string, matcher: unknown) => { calls.push([event, matcher]); }) as never);
    expect(calls).toEqual([['ui.render', { component: 'AgentRow' }]]);
  });

  it('should_draw_the_default_row_when_there_is_no_config_file', async () => {
    const w = world({ now: 1_072_000 });
    const text = strip(await boot(w).body());
    expect(text).toContain('general-purpose');
    expect(text).toContain('$0.05');
    expect(text).toContain('1m12s');
    expect(w.stats).toEqual([CONFIG]);
  });

  it('should_read_the_config_on_the_very_first_row_even_when_the_clock_starts_at_zero', async () => {
    const w = world({ now: 0, files: { [CONFIG]: { mtimeMs: 1, text: '{"subagentRow":{"cost":false}}' } } });
    const text = strip(await boot(w).body());
    expect(w.reads).toEqual([CONFIG]);
    expect(text).not.toContain('$');
  });

  it('should_keep_every_other_prop_and_only_set_the_body', async () => {
    const { row } = boot(world());
    const out = await row();
    expect(out.props.rowIds).toEqual(['a1']);
    expect(out.props.isHidden).toBe(false);
    expect(typeof out.props.body).toBe('string');
  });

  it('should_use_userprofile_on_windows', async () => {
    const path = 'C:\\Users\\x/.config/lumira/config.json';
    const w = world({ platform: 'windows', env: { USERPROFILE: 'C:\\Users\\x', HOME: '/msys/home/x' } });
    await boot(w).body();
    expect(w.stats).toEqual([path]);
  });

  it('should_fall_back_to_the_defaults_when_no_home_dir_is_set', async () => {
    const w = world({ env: {} });
    const text = strip(await boot(w).body());
    expect(w.stats).toEqual([]);
    expect(text).toContain('$0.05');
  });

  it('should_check_the_file_at_most_once_every_five_seconds', async () => {
    const w = world({ now: 100_000 });
    const { body } = boot(w);
    await body();
    w.now = 104_999;
    await body();
    expect(w.stats).toHaveLength(1);
    w.now = 105_000;
    await body();
    expect(w.stats).toHaveLength(2);
  });

  it('should_reread_only_when_the_modification_time_changed', async () => {
    const w = world({ now: 0, files: { [CONFIG]: { mtimeMs: 10, text: '{"subagentRow":{"cost":false}}' } } });
    const { body } = boot(w);
    await body();
    w.now = 5_000;
    await body();
    expect(w.reads).toHaveLength(1);

    w.files[CONFIG] = { mtimeMs: 20, text: '{"subagentRow":{"cost":true,"type":false}}' };
    w.now = 10_000;
    const text = strip(await body());
    expect(w.reads).toHaveLength(2);
    expect(text).toContain('$0.05');
    expect(text).not.toContain('general-purpose');
  });

  it('should_go_back_to_the_defaults_when_the_config_file_disappears', async () => {
    const w = world({ now: 0, files: { [CONFIG]: { mtimeMs: 10, text: '{"subagentRow":{"cost":false}}' } } });
    const { body } = boot(w);
    expect(strip(await body())).not.toContain('$');
    delete w.files[CONFIG];
    w.now = 5_000;
    expect(strip(await body())).toContain('$0.05');
  });

  it('should_keep_the_last_good_options_when_a_read_fails_after_the_stat_succeeded', async () => {
    const w = world({ now: 0, files: { [CONFIG]: { mtimeMs: 10, text: '{"subagentRow":{"cost":false}}' } } });
    const { body } = boot(w);
    expect(strip(await body())).not.toContain('$');

    w.files[CONFIG] = { mtimeMs: 20, text: '{}' };
    w.unreadable.add(CONFIG);
    w.now = 5_000;
    expect(strip(await body())).not.toContain('$');

    w.unreadable.clear();
    w.now = 10_000;
    expect(strip(await body())).toContain('$0.05');
  });

  it('should_use_the_defaults_for_a_config_that_is_not_valid_json', async () => {
    const w = world({ files: { [CONFIG]: { mtimeMs: 1, text: '{ nope' } } });
    expect(strip(await boot(w).body())).toContain('$0.05');
  });

  it('should_leave_the_engine_row_alone_when_formatting_throws', async () => {
    const { row, next } = boot(world());
    const hostile = {
      get description(): string {
        throw new Error('boom');
      },
    };
    const out = await row(hostile);
    expect(out.props.body).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect((next.mock.calls[0][0] as { props: Record<string, unknown> }).props.body).toBeUndefined();
  });
});
