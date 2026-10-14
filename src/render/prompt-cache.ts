import type { PromptCacheInfo } from '../normalize.js';
import { formatTokens } from '../utils/format.js';
import type { ColorName } from './colors.js';

export const MISS_VISIBLE_SEC = 300;
const MAX_CLOCK_SKEW_SEC = 60;

export type PromptCacheBadgeKind = 'miss' | 'cold' | 'expiring';

export const PROMPT_CACHE_COLORS: Record<PromptCacheBadgeKind, ColorName> = {
  miss: 'orange',
  cold: 'cyan',
  expiring: 'yellow',
};

export interface PromptCacheBadge {
  kind: PromptCacheBadgeKind;
  text: string;
}

export interface PromptCacheBadgeOptions {
  icon: string;
  /**
   * True only when something re-renders the statusline on a timer. CC renders
   * on events, so without one a countdown freezes and lies — an absolute clock
   * time stays correct no matter how long the line goes without a render.
   */
  liveCountdown: boolean;
  nowSec?: number;
}

/** A minute-granularity countdown stays honest only if the line re-renders at least once a minute. */
export function isLiveRefresh(refreshInterval: number | undefined): boolean {
  return refreshInterval != null && refreshInterval <= 60;
}

const CAUSE_LABELS = new Map<string, string>([
  ['ttl_expired_1h', 'idle >1h'],
  ['ttl_expired_5m', 'idle >5m'],
  ['model_changed', 'model changed'],
  ['tools_changed', 'tools changed'],
  ['system_prompt_changed', 'prompt changed'],
  ['likely_server_side', 'server-side'],
]);

function causeLabel(cause: string): string {
  return CAUSE_LABELS.get(cause) ?? cause.replace(/_/g, ' ');
}

function expiringThresholdSec(ttlSec: number): number {
  return ttlSec >= 3600 ? 600 : 60;
}

function clockTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function withCost(label: string, recacheIfCold: number | undefined): string {
  return recacheIfCold ? `${label} · ${formatTokens(recacheIfCold)}` : label;
}

export function getPromptCacheBadge(
  pc: PromptCacheInfo | undefined,
  opts: PromptCacheBadgeOptions,
): PromptCacheBadge | null {
  if (!pc) return null;
  const now = opts.nowSec ?? Date.now() / 1000;
  const prefix = opts.icon ? `${opts.icon} ` : '';

  // Cold and expiring outrank a recent miss: they are time-sensitive, and on a
  // 5m TTL the miss window would otherwise cover the entire last-minute warning.
  if (pc.cachingObserved) {
    const remaining = pc.expiresAt != null ? pc.expiresAt - now : undefined;
    if (!pc.warm || (remaining != null && remaining <= 0)) {
      return { kind: 'cold', text: withCost(`${prefix}cold`, pc.recacheIfCold) };
    }
    if (remaining != null && pc.ttlSec != null && remaining <= expiringThresholdSec(pc.ttlSec)) {
      const when = opts.liveCountdown
        ? (remaining < 60 ? '<1m' : `${Math.floor(remaining / 60)}m`)
        : clockTime(pc.expiresAt!);
      return { kind: 'expiring', text: withCost(`${prefix}${when}`, pc.recacheIfCold) };
    }
  }

  const missAge = pc.lastMissAt != null ? now - pc.lastMissAt : undefined;
  if (pc.misses > 0 && missAge != null && missAge >= -MAX_CLOCK_SKEW_SEC && missAge <= MISS_VISIBLE_SEC) {
    const parts = [`miss ×${pc.misses}`];
    if (pc.missRecacheTokens > 0) parts.push(formatTokens(pc.missRecacheTokens));
    if (pc.lastMissCauses.length > 0) parts.push(pc.lastMissCauses.map(causeLabel).join(', '));
    return { kind: 'miss', text: parts.join(' · ') };
  }

  return null;
}
