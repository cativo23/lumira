import { debug } from '../utils/debug.js';
import { computeBurnExtrapolation } from './burn-math.js';
const log = debug('quota-projection');
// `willExhaustBefore` alone is a zero-margin trigger: algebraically it's just
// `usedPct > elapsedPct`, i.e. "a hair above a perfectly linear pace". Right after
// a window reset, elapsedPct starts near 0, so any early burst of usage clears it —
// an 11h heavy session burning 11% of a 7-day quota reads as "will exhaust in ~29h"
// even though the session already ended. These floors require actual evidence
// (real margin, meaningful usage, meaningful time passed) before surfacing a warning.
const MIN_USED_PCT_FOR_WARNING = 25;
const MIN_ELAPSED_FRACTION_FOR_WARNING = 0.1;
const MIN_DELTA_MARGIN_PCT = 5;
/**
 * Extrapolates current burn rate to when the quota would hit 100%.
 *
 * Window-agnostic: caller passes `windowSec` (e.g. 5*3600 for 5h, 7*24*3600 for 7d).
 * The 7d caller must override `minElapsedSec` to 3600 — the default 300s is the right
 * floor for a 5h window but too aggressive for 7d: a user who burns 10% in the first
 * hour would otherwise trigger projection warnings the steady-state rate won't sustain.
 */
export function computeQuotaProjection(usedPct, resetsAt, windowSec, nowSec, minElapsedSec = 300) {
    const now = nowSec ?? Date.now() / 1000;
    if (resetsAt === undefined || resetsAt <= now) {
        if (log.enabled)
            log({ reason: 'no resetsAt or already past', resetsAt, now });
        return null;
    }
    if (!Number.isFinite(usedPct) || usedPct <= 0 || usedPct >= 100) {
        if (log.enabled)
            log({ reason: 'usedPct out of projectable range', usedPct });
        return null;
    }
    const remainingSec = resetsAt - now;
    const elapsedSec = windowSec - remainingSec;
    if (elapsedSec < minElapsedSec) {
        if (log.enabled)
            log({ reason: 'insufficient elapsed', elapsedSec, minElapsedSec });
        return null;
    }
    const burn = computeBurnExtrapolation(usedPct, elapsedSec, remainingSec);
    const elapsedFraction = elapsedSec / windowSec;
    const hasEnoughSignal = usedPct >= MIN_USED_PCT_FOR_WARNING &&
        elapsedFraction >= MIN_ELAPSED_FRACTION_FOR_WARNING &&
        burn.delta >= MIN_DELTA_MARGIN_PCT;
    const willExhaustBefore = burn.willExhaustBefore && hasEnoughSignal;
    if (log.enabled) {
        log({
            usedPct,
            elapsedSec: Math.round(elapsedSec),
            remainingSec: Math.round(remainingSec),
            burnRate: burn.burnRateSec,
            timeToExhaustSec: Math.round(burn.timeToExhaustSec),
            delta: burn.delta,
            elapsedFraction,
            hasEnoughSignal,
            willExhaustBefore,
        });
    }
    return { timeToExhaustSec: burn.timeToExhaustSec, willExhaustBefore };
}
/**
 * Renders a projection as a short warning string (e.g. "⚠ Mon", "🔥 ~12h").
 *
 * Returns "" when the projection does not predict exhaustion before reset. Caller
 * may still call with `willExhaustBefore=false`; nothing breaks, output is just empty.
 *
 * `timeZone` parameter is for test determinism — in production callers omit it so
 * weekday names render in the user's local TZ. Tests pin `timeZone='UTC'` to keep
 * snapshots reproducible across CI runners.
 */
export function formatProjectionWarning(proj, nowSec, timeZone) {
    if (!proj.willExhaustBefore)
        return '';
    const tte = proj.timeToExhaustSec;
    const icon = tte < 12 * 3600 ? '🔥' : '⚠';
    if (tte < 3600) {
        // < 1h → minutes (ceil so sub-minute values don't render as "~0min")
        const mins = Math.max(1, Math.ceil(tte / 60));
        return `${icon} ~${mins}min`;
    }
    if (tte < 48 * 3600) {
        // 1h to <48h → hours
        const hours = Math.floor(tte / 3600);
        return `${icon} ~${hours}h`;
    }
    if (tte < 7 * 24 * 3600) {
        // 2d to <7d → days
        const days = Math.floor(tte / (24 * 3600));
        return `${icon} ~${days}d`;
    }
    // >= 7d → render weekday name. Pin locale to en-US so output is the same
    // 3-letter English abbreviation regardless of the user's system locale,
    // which prevents snapshot drift across machines.
    const now = nowSec ?? Date.now() / 1000;
    const exhaustDate = new Date((now + tte) * 1000);
    const formatOpts = { weekday: 'short' };
    if (timeZone)
        formatOpts.timeZone = timeZone;
    const weekday = exhaustDate.toLocaleDateString('en-US', formatOpts);
    return `${icon} ${weekday}`;
}
//# sourceMappingURL=quota-projection.js.map