import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';

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
