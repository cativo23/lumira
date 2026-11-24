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
  let checkedAt = 0;
  let seenMtime = -1;

  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    const now = await $.clock.now();

    if (now - checkedAt >= RECHECK_MS) {
      checkedAt = now;
      try {
        if (path === undefined) {
          const { platform } = await $.session.info();
          const home = pickHome(platform, await $.env.get('HOME'), await $.env.get('USERPROFILE'));
          if (home !== undefined) path = configFile(home);
        }
        if (path !== undefined) {
          const { mtimeMs } = await $.fs.stat(path);
          if (mtimeMs !== seenMtime) {
            options = resolveRowOptions(parseConfig(await $.fs.read(path)));
            seenMtime = mtimeMs;
          }
        }
      } catch {
        options = DEFAULT_ROW_OPTIONS;
        seenMtime = -1;
      }
    }

    return next({ ...e, props: { ...e.props, body: formatRow(e.props, options, now) } });
  });
};
