import { createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeTermString } from '../normalize.js';
// Bump whenever the parsing rules or the persisted shape change: an old
// checkpoint would otherwise resume under rules it was not produced with.
export const CHECKPOINT_SCHEMA = 1;
const HEAD_BYTES = 4096;
const TAIL_BYTES = 256;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_CHECKPOINT_FILES = 20;
const STALE_TMP_MS = 3600 * 1000;
// Only the last few tools/agents are ever rendered, so the checkpoint keeps a
// bounded window (plus anything still running, which a later tool_result must
// be able to complete) instead of every tool call of a very long session.
const KEEP_TOOLS = 200;
const KEEP_AGENTS = 50;
export function newParseState() {
    return {
        offset: 0,
        lineCount: 0,
        truncated: false,
        sessionStart: null,
        compactionCount: 0,
        thinkingEffort: '',
        toolMap: new Map(),
        agentMap: new Map(),
        todos: [],
        taskIdToIndex: new Map(),
    };
}
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const TOOL_STATUSES = new Set(['running', 'completed', 'error']);
const toStamp = (d) => (Number.isNaN(d.getTime()) ? 'invalid' : d.getTime());
const fromStamp = (v) => new Date(v === 'invalid' ? NaN : v);
const isStamp = (v) => v === 'invalid' || isNum(v);
function toSerializedTimed(e) {
    const { startTime, endTime, ...rest } = e;
    const out = { ...rest, startTime: toStamp(startTime) };
    if (endTime)
        out.endTime = toStamp(endTime);
    return out;
}
function fromSerializedTimed(e) {
    const { startTime, endTime, ...rest } = e;
    const out = { ...rest, startTime: fromStamp(startTime) };
    if (endTime !== undefined)
        out.endTime = fromStamp(endTime);
    return out;
}
function boundedTail(entries, keep) {
    const recent = entries.slice(-keep);
    const evictedRunning = entries.slice(0, -keep).filter(e => e.status === 'running').slice(-keep);
    return evictedRunning.length > 0 ? [...evictedRunning, ...recent] : recent;
}
export function sha1(buf) {
    return createHash('sha1').update(buf).digest('hex');
}
/** Hashes the first and last bytes of the consumed region; a mismatch means the file was replaced or rewritten. */
export function fingerprint(fd, offset) {
    const read = (len, pos) => {
        const buf = Buffer.alloc(len);
        const n = len > 0 ? readSync(fd, buf, 0, len, pos) : 0;
        return buf.subarray(0, n);
    };
    const headLen = Math.min(HEAD_BYTES, offset);
    const tailLen = Math.min(TAIL_BYTES, offset);
    return { head: sha1(read(headLen, 0)), tail: sha1(read(tailLen, offset - tailLen)) };
}
export function serializeCheckpoint(cp) {
    const s = cp.state;
    return JSON.stringify({
        schema: CHECKPOINT_SCHEMA,
        ino: cp.ino,
        head: cp.head,
        tail: cp.tail,
        offset: s.offset,
        lineCount: s.lineCount,
        truncated: s.truncated,
        sessionStart: s.sessionStart ? toStamp(s.sessionStart) : null,
        compactionCount: s.compactionCount,
        thinkingEffort: s.thinkingEffort,
        tools: boundedTail([...s.toolMap.values()], KEEP_TOOLS).map(toSerializedTimed),
        agents: boundedTail([...s.agentMap.values()], KEEP_AGENTS).map(toSerializedTimed),
        todos: s.todos,
        taskIds: [...s.taskIdToIndex.entries()],
        subagents: cp.subagents
            ? { dir: cp.subagents.dir, agents: cp.subagents.agents.map(toSerializedTimed) }
            : null,
    });
}
function validTimed(v) {
    return isRecord(v) && typeof v.id === 'string' && isStamp(v.startTime) && (v.endTime === undefined || isStamp(v.endTime));
}
// Fields are re-validated and re-sanitised on load: the checkpoint is a file
// on disk, so what comes back is not trusted to be what parseTranscript wrote.
function readAgent(v) {
    if (!validTimed(v) || typeof v.type !== 'string' || !TOOL_STATUSES.has(v.status))
        return null;
    for (const k of ['model', 'description']) {
        if (v[k] !== undefined && typeof v[k] !== 'string')
            return null;
    }
    const agent = fromSerializedTimed(v);
    agent.type = sanitizeTermString(agent.type);
    if (agent.model !== undefined)
        agent.model = sanitizeTermString(agent.model);
    if (agent.description !== undefined)
        agent.description = sanitizeTermString(agent.description);
    return agent;
}
function deserializeCheckpoint(raw) {
    if (!isRecord(raw) || raw.schema !== CHECKPOINT_SCHEMA)
        return null;
    if (!isCount(raw.ino) || !isCount(raw.offset) || !isCount(raw.lineCount) || !isCount(raw.compactionCount))
        return null;
    if (typeof raw.head !== 'string' || typeof raw.tail !== 'string' || typeof raw.truncated !== 'boolean')
        return null;
    if (typeof raw.thinkingEffort !== 'string')
        return null;
    if (!Array.isArray(raw.tools) || !Array.isArray(raw.agents) || !Array.isArray(raw.todos) || !Array.isArray(raw.taskIds))
        return null;
    const state = newParseState();
    state.offset = raw.offset;
    state.lineCount = raw.lineCount;
    state.truncated = raw.truncated;
    state.compactionCount = raw.compactionCount;
    state.thinkingEffort = raw.thinkingEffort;
    if (raw.sessionStart !== null) {
        if (!isStamp(raw.sessionStart))
            return null;
        state.sessionStart = fromStamp(raw.sessionStart);
    }
    for (const t of raw.tools) {
        if (!validTimed(t) || typeof t.name !== 'string' || !TOOL_STATUSES.has(t.status))
            return null;
        if (t.target !== undefined && typeof t.target !== 'string')
            return null;
        const tool = fromSerializedTimed(t);
        tool.name = sanitizeTermString(tool.name);
        if (tool.target !== undefined)
            tool.target = sanitizeTermString(tool.target);
        state.toolMap.set(tool.id, tool);
    }
    for (const a of raw.agents) {
        const agent = readAgent(a);
        if (!agent)
            return null;
        state.agentMap.set(agent.id, agent);
    }
    for (const t of raw.todos) {
        if (!isRecord(t) || typeof t.content !== 'string' || typeof t.id !== 'string' || !['pending', 'in_progress', 'completed'].includes(t.status))
            return null;
        state.todos.push(t);
    }
    for (const pair of raw.taskIds) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !isCount(pair[1]))
            return null;
        state.taskIdToIndex.set(pair[0], pair[1]);
    }
    let subagents = null;
    if (isRecord(raw.subagents)) {
        const sa = raw.subagents;
        if (!Array.isArray(sa.agents))
            return null;
        const dir = isRecord(sa.dir) && isNum(sa.dir.count) && isNum(sa.dir.maxMtimeMs) && isNum(sa.dir.totalSize)
            ? { count: sa.dir.count, maxMtimeMs: sa.dir.maxMtimeMs, totalSize: sa.dir.totalSize }
            : null;
        const agents = [];
        for (const a of sa.agents) {
            const agent = readAgent(a);
            if (!agent)
                return null;
            agents.push(agent);
        }
        subagents = { dir, agents };
    }
    return { state, ino: raw.ino, head: raw.head, tail: raw.tail, subagents };
}
function checkpointPath(cacheDir, resolvedTranscript) {
    return join(cacheDir, createHash('sha256').update(resolvedTranscript).digest('hex').slice(0, 32) + '.json');
}
// The checkpoint holds fragments of the user's tool inputs (Bash commands,
// file paths), so the directory must be private and ours, never a symlink.
function dirIsTrusted(cacheDir) {
    try {
        const st = lstatSync(cacheDir);
        if (!st.isDirectory() || st.isSymbolicLink())
            return false;
        if (typeof process.getuid === 'function' && st.uid !== process.getuid())
            return false;
        if (process.platform !== 'win32' && (st.mode & 0o022) !== 0)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
export function loadCheckpoint(cacheDir, resolvedTranscript) {
    try {
        if (!dirIsTrusted(cacheDir))
            return null;
        const path = checkpointPath(cacheDir, resolvedTranscript);
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_CHECKPOINT_BYTES)
            return null;
        return deserializeCheckpoint(JSON.parse(readFileSync(path, 'utf8')));
    }
    catch {
        return null;
    }
}
function prune(cacheDir) {
    try {
        const all = readdirSync(cacheDir);
        for (const f of all) {
            if (!f.endsWith('.tmp'))
                continue;
            try {
                if (Date.now() - statSync(join(cacheDir, f)).mtimeMs > STALE_TMP_MS)
                    unlinkSync(join(cacheDir, f));
            }
            catch { /* concurrent writer finished */ }
        }
        const files = all
            .filter(f => f.endsWith('.json'))
            .map(f => ({ f, m: statSync(join(cacheDir, f)).mtimeMs }));
        if (files.length <= MAX_CHECKPOINT_FILES)
            return;
        files.sort((a, b) => a.m - b.m);
        for (const { f } of files.slice(0, files.length - MAX_CHECKPOINT_FILES)) {
            try {
                unlinkSync(join(cacheDir, f));
            }
            catch { /* concurrent prune */ }
        }
    }
    catch { /* best effort */ }
}
export function saveCheckpoint(cacheDir, resolvedTranscript, serialized) {
    // A checkpoint over the load cap would be rewritten every tick and never read.
    if (serialized.length > MAX_CHECKPOINT_BYTES)
        return;
    let tmp = null;
    try {
        mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        if (!dirIsTrusted(cacheDir))
            return;
        const path = checkpointPath(cacheDir, resolvedTranscript);
        tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
        const fd = openSync(tmp, 'wx', 0o600);
        try {
            writeSync(fd, serialized);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, path);
        tmp = null;
        prune(cacheDir);
    }
    catch {
        /* checkpoint is best effort; the next tick just parses more */
    }
    finally {
        if (tmp) {
            try {
                unlinkSync(tmp);
            }
            catch { /* already gone */ }
        }
    }
}
//# sourceMappingURL=transcript-checkpoint.js.map