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
function realDir(dir) {
    try {
        return realpathSync(dir);
    }
    catch {
        return dir;
    }
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
        // Dangling: walk the chain by hand to the first path that isn't a link.
        let current = path;
        for (let hops = 0; hops < 40; hops++) {
            try {
                if (!lstatSync(current).isSymbolicLink())
                    return current;
            }
            catch {
                return current;
            }
            // Resolve against the link's real directory: the OS applies `..` after
            // following any directory symlink earlier in the path, not textually.
            current = resolve(realDir(dirname(current)), readlinkSync(current));
        }
        throw new Error(`${path}: too many levels of symbolic links`);
    }
}
//# sourceMappingURL=json-file.js.map