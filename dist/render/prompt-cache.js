import { formatTokens } from '../utils/format.js';
export const MISS_VISIBLE_SEC = 300;
const MAX_CLOCK_SKEW_SEC = 60;
export const PROMPT_CACHE_COLORS = {
    miss: 'orange',
    cold: 'cyan',
    expiring: 'yellow',
};
/** A minute-granularity countdown stays honest only if the line re-renders at least once a minute. */
export function isLiveRefresh(refreshInterval) {
    return refreshInterval != null && refreshInterval <= 60;
}
const CAUSE_LABELS = new Map([
    ['ttl_expired_1h', 'idle >1h'],
    ['ttl_expired_5m', 'idle >5m'],
    ['model_changed', 'model changed'],
    ['tools_changed', 'tools changed'],
    ['system_prompt_changed', 'prompt changed'],
    ['likely_server_side', 'server-side'],
]);
function causeLabel(cause) {
    return CAUSE_LABELS.get(cause) ?? cause.replace(/_/g, ' ');
}
function expiringThresholdSec(ttlSec) {
    return ttlSec >= 3600 ? 600 : 60;
}
function clockTime(epochSec) {
    const d = new Date(epochSec * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function withCost(label, recacheIfCold) {
    return recacheIfCold ? `${label} · ${formatTokens(recacheIfCold)}` : label;
}
export function getPromptCacheBadge(pc, opts) {
    if (!pc)
        return null;
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
                : clockTime(pc.expiresAt);
            return { kind: 'expiring', text: withCost(`${prefix}${when}`, pc.recacheIfCold) };
        }
    }
    const missAge = pc.lastMissAt != null ? now - pc.lastMissAt : undefined;
    if (pc.misses > 0 && missAge != null && missAge >= -MAX_CLOCK_SKEW_SEC && missAge <= MISS_VISIBLE_SEC) {
        const parts = [`miss ×${pc.misses}`];
        if (pc.missRecacheTokens > 0)
            parts.push(formatTokens(pc.missRecacheTokens));
        if (pc.lastMissCauses.length > 0)
            parts.push(pc.lastMissCauses.map(causeLabel).join(', '));
        return { kind: 'miss', text: parts.join(' · ') };
    }
    return null;
}
//# sourceMappingURL=prompt-cache.js.map