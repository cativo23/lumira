import { readFileSync, readlinkSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
/**
 * Read a user-owned settings/config file that must hold a JSON object.
 * Anything else throws before a single byte is written: replacing a file
 * with a syntax error from a hand edit would silently drop everything in it.
 */
export function readJsonObject(path) {
    const fix = 'Fix it and run the command again — nothing was changed.';
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch (e) {
        throw new Error(`${path} could not be read (${e.message}). ${fix}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (e) {
        throw new Error(`${path} is not valid JSON (${e.message}). ${fix}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${path} is not a JSON object. ${fix}`);
    }
    return parsed;
}
/**
 * The path an atomic temp-file + rename should land on. Renaming onto a
 * symlink replaces the link with a plain file (detaching a dotfiles-managed
 * settings.json), so follow it — including a link whose target doesn't
 * exist yet.
 */
export function writeTarget(path) {
    try {
        if (!lstatSync(path).isSymbolicLink())
            return path;
    }
    catch {
        return path;
    }
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(dirname(path), readlinkSync(path));
    }
}
//# sourceMappingURL=json-file.js.map