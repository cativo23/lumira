import { describe, it, expect } from 'vitest';
import { getPromptCacheBadge, isLiveRefresh, MISS_VISIBLE_SEC } from '../../src/render/prompt-cache.js';
import type { PromptCacheInfo } from '../../src/normalize.js';

const NOW = 1792005600;
const ICON = '❄';

function pc(overrides: Partial<PromptCacheInfo> = {}): PromptCacheInfo {
  return {
    warm: true,
    cachingObserved: true,
    ttlSec: 3600,
    expiresAt: NOW + 3000,
    misses: 0,
    missRecacheTokens: 0,
    lastMissAt: undefined,
    lastMissCauses: [],
    recacheIfCold: 102957,
    ...overrides,
  };
}

function badge(info: PromptCacheInfo | undefined, liveCountdown = true) {
  return getPromptCacheBadge(info, { icon: ICON, liveCountdown, nowSec: NOW });
}

function clock(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('getPromptCacheBadge', () => {
  it('returns null when prompt_cache is absent', () => {
    expect(badge(undefined)).toBeNull();
  });

  it('stays hidden while the cache is warm with plenty of TTL left', () => {
    expect(badge(pc())).toBeNull();
  });

  it('stays hidden when caching was never observed', () => {
    expect(badge(pc({ warm: false, cachingObserved: false }))).toBeNull();
  });

  describe('expiring', () => {
    it('shows a minute countdown and the re-cache cost when a refresh timer keeps it live', () => {
      expect(badge(pc({ expiresAt: NOW + 8 * 60 + 30 }))).toEqual({ kind: 'expiring', text: '❄ 8m · 103k' });
    });

    it('shows the absolute clock time when nothing re-renders on a timer', () => {
      const expiresAt = NOW + 8 * 60;
      expect(badge(pc({ expiresAt }), false)).toEqual({ kind: 'expiring', text: `❄ ${clock(expiresAt)} · 103k` });
    });

    it('shows <1m in the last minute', () => {
      expect(badge(pc({ expiresAt: NOW + 59 }))?.text).toBe('❄ <1m · 103k');
    });

    it('starts exactly at the 10-minute threshold for a 1h TTL', () => {
      expect(badge(pc({ expiresAt: NOW + 600 }))?.kind).toBe('expiring');
      expect(badge(pc({ expiresAt: NOW + 601 }))).toBeNull();
    });

    it('uses a 1-minute threshold for a 5m TTL', () => {
      expect(badge(pc({ ttlSec: 300, expiresAt: NOW + 60 }))?.kind).toBe('expiring');
      expect(badge(pc({ ttlSec: 300, expiresAt: NOW + 61 }))).toBeNull();
    });

    it('stays hidden when the TTL is unknown', () => {
      expect(badge(pc({ ttlSec: undefined, expiresAt: NOW + 60 }))).toBeNull();
    });

    it('omits the cost when recache_tokens_if_cold is null or zero', () => {
      expect(badge(pc({ expiresAt: NOW + 300, recacheIfCold: undefined }))?.text).toBe('❄ 5m');
      expect(badge(pc({ expiresAt: NOW + 300, recacheIfCold: 0 }))?.text).toBe('❄ 5m');
    });
  });

  describe('cold', () => {
    it('shows cold with the cost to re-cache', () => {
      expect(badge(pc({ warm: false, expiresAt: NOW - 100 }))).toEqual({ kind: 'cold', text: '❄ cold · 103k' });
    });

    it('treats a warm payload whose expires_at already passed as cold', () => {
      expect(badge(pc({ expiresAt: NOW }))).toEqual({ kind: 'cold', text: '❄ cold · 103k' });
    });

    it('omits the icon prefix when the icon is empty', () => {
      const r = getPromptCacheBadge(pc({ warm: false }), { icon: '', liveCountdown: true, nowSec: NOW });
      expect(r?.text).toBe('cold · 103k');
    });
  });

  describe('recent miss', () => {
    const missed = pc({
      misses: 2,
      missRecacheTokens: 202640,
      lastMissAt: NOW - 30,
      lastMissCauses: ['model_changed'],
    });

    it('shows the session miss count, cumulative re-cache tokens, and a readable cause', () => {
      expect(badge(missed)).toEqual({ kind: 'miss', text: 'miss ×2 · 203k · model changed' });
    });

    it('yields to cold and expiring, which are time-sensitive', () => {
      expect(badge({ ...missed, warm: false })?.kind).toBe('cold');
      expect(badge({ ...missed, expiresAt: NOW + 60 })?.kind).toBe('expiring');
    });

    it('does not hide the last-minute warning on a 5m TTL after a miss', () => {
      const lastMissAt = NOW - 250;
      const fiveMin = { ...missed, ttlSec: 300, lastMissAt, expiresAt: lastMissAt + 300 };
      expect(badge(fiveMin)?.text).toBe('❄ <1m · 103k');
    });

    it('tolerates up to 60s of clock skew on last_miss_at', () => {
      expect(badge({ ...missed, lastMissAt: NOW + 60 })?.kind).toBe('miss');
    });

    it('ignores a last_miss_at further in the future instead of pinning the badge', () => {
      expect(badge({ ...missed, lastMissAt: NOW + 61 })).toBeNull();
      expect(badge({ ...missed, lastMissAt: NOW * 1000 })).toBeNull();
    });

    it(`hides once the miss is older than ${MISS_VISIBLE_SEC}s`, () => {
      expect(badge({ ...missed, lastMissAt: NOW - MISS_VISIBLE_SEC })?.kind).toBe('miss');
      expect(badge({ ...missed, lastMissAt: NOW - MISS_VISIBLE_SEC - 1 })).toBeNull();
    });

    it('translates every documented cause', () => {
      const causes = ['ttl_expired_1h', 'ttl_expired_5m', 'tools_changed', 'system_prompt_changed', 'likely_server_side'];
      expect(badge({ ...missed, lastMissCauses: causes })?.text)
        .toBe('miss ×2 · 203k · idle >1h, idle >5m, tools changed, prompt changed, server-side');
    });

    it('passes unknown causes through with underscores as spaces', () => {
      expect(badge({ ...missed, lastMissCauses: ['brand_new_cause'] })?.text).toBe('miss ×2 · 203k · brand new cause');
    });

    it('omits the cause when CC could not identify one', () => {
      expect(badge({ ...missed, lastMissCauses: [] })?.text).toBe('miss ×2 · 203k');
    });

    it('omits the token count when nothing was re-cached', () => {
      expect(badge({ ...missed, missRecacheTokens: 0, lastMissCauses: [] })?.text).toBe('miss ×2');
    });
  });

  it('treats only a refresh of a minute or faster as live', () => {
    expect(isLiveRefresh(undefined)).toBe(false);
    expect(isLiveRefresh(5)).toBe(true);
    expect(isLiveRefresh(60)).toBe(true);
    expect(isLiveRefresh(61)).toBe(false);
  });

  it('defaults nowSec to the current time', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60 + 30;
    const r = getPromptCacheBadge(pc({ expiresAt }), { icon: ICON, liveCountdown: true });
    expect(r?.text).toBe('❄ 5m · 103k');
  });
});
