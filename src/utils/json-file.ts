import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read a user-owned settings/config file that must hold a JSON object.
 * Anything else throws before a single byte is written: replacing a file
 * with a syntax error from a hand edit would silently drop everything in it.
 */
export function readJsonObject(path: string): Record<string, unknown> {
  const fix = 'Fix it and run the command again — nothing was changed.';
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`${path} could not be read (${(e as Error).message}). ${fix}`);
  }
  // An empty file holds nothing to lose. writeTarget can also leave one
  // behind (the placeholder for a dangling link) if the write after it fails.
  text = text.replace(/^\uFEFF/, '');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}). ${fix}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object. ${fix}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The path an atomic temp-file + rename should land on. Renaming onto a
 * symlink replaces the link with a plain file (detaching a dotfiles-managed
 * settings.json), so follow it — including a link whose target doesn't
 * exist yet.
 */
export function writeTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path;
  } catch {
    return path;
  }
  try {
    return realpathSync.native(path);
  } catch {
    // Dangling: let the OS resolve the chain (it applies `..` after following
    // directory links, which is easy to get wrong by hand) by creating the
    // missing target through the link, then ask for its real path. A missing
    // directory or a loop throws here, exactly as the write would. The native
    // realpath is required: the JS one also applies `..` textually.
    try {
      closeSync(openSync(path, 'a', 0o600));
    } catch (e) {
      throw new Error(`The target of the symlink ${path} could not be created (${(e as Error).message}). Check the link and the directory it points into.`);
    }
    return realpathSync.native(path);
  }
}

/**
 * Fail before any write when `target` can't be replaced by rename — the
 * directory holding it (or, for a first install, its nearest existing
 * ancestor) must be writable. Catches read-only targets such as a
 * home-manager link into /nix/store before settings.json is touched.
 */
export function assertWritable(target: string): void {
  let dir = dirname(target);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error(`${target} is not writable (${dir} is read-only). Make it writable or point the link elsewhere — nothing was changed.`);
  }
}
