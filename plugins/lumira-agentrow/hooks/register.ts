import type { Register } from 'claude-code';
import {
  DEFAULT_ROW_OPTIONS,
  configFile,
  formatRow,
  parseConfig,
  pickHome,
  resolveRowOptions,
  type RowOptions,
} from './row.js';

const RECHECK_MS = 5000;

export const register: Register = on => {
  let options: RowOptions = DEFAULT_ROW_OPTIONS;
  let path: string | undefined;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let seenMtime = -1;

  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    const now = await $.clock.now();

    if (now - checkedAt >= RECHECK_MS) {
      checkedAt = now;

      if (path === undefined) {
        try {
          const { platform } = await $.session.info();
          const home = pickHome(platform, await $.env.get('HOME'), await $.env.get('USERPROFILE'));
          if (home !== undefined) path = configFile(home);
        } catch {
          path = undefined;
        }
      }

      if (path !== undefined) {
        let mtimeMs: number | undefined;
        try {
          mtimeMs = (await $.fs.stat(path)).mtimeMs;
        } catch {
          // No file: the defaults apply.
          options = DEFAULT_ROW_OPTIONS;
          seenMtime = -1;
        }

        if (mtimeMs !== undefined && mtimeMs !== seenMtime) {
          try {
            options = resolveRowOptions(parseConfig(await $.fs.read(path)));
            seenMtime = mtimeMs;
          } catch {
            // A read that failed after a good stat (a write in progress): keep
            // the options already in force and try again at the next check.
          }
        }
      }
    }

    let body: string | undefined;
    try {
      body = formatRow(e.props, options, now);
    } catch {
      // Odd data from the engine: leave this one row to Claude Code.
    }
    return body === undefined ? next(e) : next({ ...e, props: { ...e.props, body } });
  });
};
