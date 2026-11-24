export interface AgentView {
  type: string;
  model?: string;
  effort?: string | number;
  description: string;
  taskStatus: string;
  startTime: number;
  cost?: { usd: number };
  contextWindowSize?: number;
  tokenCount: number;
  tokenSamples: number[];
}

export interface RowOptions {
  type: boolean;
  effort: boolean;
  elapsed: boolean;
  cost: boolean;
  context: boolean;
  sparkline: boolean;
  ascii: boolean;
}

export const DEFAULT_ROW_OPTIONS: RowOptions = {
  type: true,
  effort: true,
  elapsed: true,
  cost: true,
  context: true,
  sparkline: false,
  ascii: false,
};

const TOGGLES = ['type', 'effort', 'elapsed', 'cost', 'context', 'sparkline'] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function resolveRowOptions(raw: unknown): RowOptions {
  const options = { ...DEFAULT_ROW_OPTIONS };
  if (!isObject(raw)) return options;

  const block = isObject(raw.subagentRow) ? raw.subagentRow : {};
  for (const key of TOGGLES) {
    const value = has(block, key) ? block[key] : undefined;
    if (typeof value === 'boolean') options[key] = value;
  }
  options.ascii = raw.icons === 'none';
  return options;
}

// Node's homedir() reads USERPROFILE on Windows and HOME elsewhere; the mod has
// no Node, so it mirrors that order.
export function pickHome(platform: string | undefined, home?: string, userProfile?: string): string | undefined {
  const order = platform === 'windows' ? [userProfile, home] : [home, userProfile];
  return order.find(v => typeof v === 'string' && v !== '');
}

export function configFile(home: string): string {
  return `${home.replace(/[\\/]+$/, '')}/.config/lumira/config.json`;
}

export function parseConfig(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const sgr = (code: number, s: string): string => `\u001b[${code}m${s}\u001b[0m`;
const dim = (s: string): string => sgr(2, s);

// Agent strings are model- or user-authored: drop escape sequences and control
// characters so a description can never move the cursor or forge a link.
const clean = (v: unknown): string =>
  String(v ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim();

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function compactTokens(n: number): string {
  if (n >= 1000) {
    const k = Math.round(n / 1000);
    return k >= 1000 ? `${(n / 1_000_000).toFixed(1)}M` : `${k}k`;
  }
  return String(n);
}

export function shortModel(model: string): string {
  return /claude-([a-z]+)/.exec(model)?.[1] ?? model;
}

const BARS = '▁▂▃▄▅▆▇█';

function sparkline(samples: number[]): string {
  const max = Math.max(...samples);
  if (samples.length < 2 || !(max > 0)) return '';
  return samples
    .slice(-8)
    .map(v => BARS[Math.min(BARS.length - 1, Math.floor((v / max) * (BARS.length - 1)))])
    .join('');
}

const STATUS_COLOR: Record<string, number> = {
  running: 36,
  completed: 32,
  failed: 31,
  killed: 33,
  paused: 33,
  pending: 2,
};

const GLYPHS: Record<string, string> = {
  running: '◔',
  completed: '✔',
  failed: '⚠',
  killed: '–',
  paused: '❚❚',
  pending: '◌',
};

const ASCII: Record<string, string> = {
  running: '*',
  completed: '+',
  failed: '!',
  killed: '-',
  paused: '=',
  pending: '.',
};

const contextColor = (pct: number): number => (pct >= 85 ? 31 : pct >= 60 ? 33 : 32);

export function formatRow(agent: AgentView, options: RowOptions, now: number): string {
  const status = clean(agent.taskStatus);
  const code = STATUS_COLOR[status] ?? 2;
  const icon = (options.ascii ? ASCII : GLYPHS)[status];
  const isRunning = status === 'running';

  const who: string[] = [];
  if (options.type && agent.type) who.push(clean(agent.type));
  if (agent.model) who.push(shortModel(clean(agent.model)));
  if (options.effort && agent.effort !== undefined) who.push(clean(agent.effort));

  const bits: string[] = [];
  if (options.elapsed && isRunning) bits.push(formatDuration(now - agent.startTime));
  if (options.cost && agent.cost) bits.push(`$${agent.cost.usd.toFixed(2)}`);
  if (options.context) {
    if (agent.contextWindowSize) {
      const pct = Math.round((agent.tokenCount / agent.contextWindowSize) * 100);
      const used = `${compactTokens(agent.tokenCount)}/${compactTokens(agent.contextWindowSize)}`;
      bits.push(`${used} ${sgr(contextColor(pct), `${pct}%`)}`);
    } else {
      bits.push(`${compactTokens(agent.tokenCount)} tok`);
    }
  }
  if (options.sparkline && isRunning) {
    const trend = sparkline(agent.tokenSamples);
    if (trend) bits.push(trend);
  }
  bits.push(sgr(code, status));

  const head = icon ? `${sgr(code, icon)} ` : '';
  const owner = who.length ? `${dim(who.join(' · '))}  ` : '';
  return `${head}${owner}${clean(agent.description)}  ${bits.join(dim(' · '))}`;
}
