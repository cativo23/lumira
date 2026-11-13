import { createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEntry, ThinkingEffort, TodoEntry, ToolEntry } from '../types.js';
import type { SubagentsDirState } from './subagents.js';

// Bump whenever the parsing rules or the persisted shape change: an old
// checkpoint would otherwise resume under rules it was not produced with.
export const CHECKPOINT_SCHEMA = 1;

const HEAD_BYTES = 4096;
const TAIL_BYTES = 256;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_CHECKPOINT_FILES = 20;
// Only the last few tools/agents are ever rendered, so the checkpoint keeps a
// bounded window (plus anything still running, which a later tool_result must
// be able to complete) instead of every tool call of a very long session.
const KEEP_TOOLS = 200;
const KEEP_AGENTS = 50;

export interface ParseState {
  /** Byte offset just past the last newline-terminated line already applied. */
  offset: number;
  lineCount: number;
  truncated: boolean;
  sessionStart: Date | null;
  compactionCount: number;
  thinkingEffort: ThinkingEffort;
  toolMap: Map<string, ToolEntry>;
  agentMap: Map<string, AgentEntry>;
  todos: TodoEntry[];
  taskIdToIndex: Map<string, number>;
}

export function newParseState(): ParseState {
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

export interface SubagentsCheckpoint {
  dir: SubagentsDirState | null;
  agents: AgentEntry[];
}

export interface Checkpoint {
  state: ParseState;
  ino: number;
  head: string;
  tail: string;
  subagents: SubagentsCheckpoint | null;
}

type Timed = { startTime: Date; endTime?: Date };
type SerializedTimed<T extends Timed> = Omit<T, 'startTime' | 'endTime'> & { startTime: number; endTime?: number };

function toSerializedTimed<T extends Timed>(e: T): SerializedTimed<T> {
  const { startTime, endTime, ...rest } = e;
  const out = { ...rest, startTime: startTime.getTime() } as SerializedTimed<T>;
  if (endTime) out.endTime = endTime.getTime();
  return out;
}

function fromSerializedTimed<T extends Timed>(e: SerializedTimed<T>): T {
  const { startTime, endTime, ...rest } = e;
  const out = { ...rest, startTime: new Date(startTime) } as unknown as T;
  if (typeof endTime === 'number') out.endTime = new Date(endTime);
  return out;
}

function boundedTail<T extends { status: string }>(entries: T[], keep: number): T[] {
  const recent = entries.slice(-keep);
  const evictedRunning = entries.slice(0, -keep).filter(e => e.status === 'running').slice(-keep);
  return evictedRunning.length > 0 ? [...evictedRunning, ...recent] : recent;
}

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** Hashes the first and last bytes of the consumed region; a mismatch means the file was replaced or rewritten. */
export function fingerprint(fd: number, offset: number): { head: string; tail: string } {
  const read = (len: number, pos: number): Buffer => {
    const buf = Buffer.alloc(len);
    const n = len > 0 ? readSync(fd, buf, 0, len, pos) : 0;
    return buf.subarray(0, n);
  };
  const headLen = Math.min(HEAD_BYTES, offset);
  const tailLen = Math.min(TAIL_BYTES, offset);
  return { head: sha1(read(headLen, 0)), tail: sha1(read(tailLen, offset - tailLen)) };
}

export function serializeCheckpoint(cp: Checkpoint): string {
  const s = cp.state;
  return JSON.stringify({
    schema: CHECKPOINT_SCHEMA,
    ino: cp.ino,
    head: cp.head,
    tail: cp.tail,
    offset: s.offset,
    lineCount: s.lineCount,
    truncated: s.truncated,
    sessionStart: s.sessionStart ? s.sessionStart.getTime() : null,
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

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function deserializeCheckpoint(raw: unknown): Checkpoint | null {
  if (!isRecord(raw) || raw.schema !== CHECKPOINT_SCHEMA) return null;
  if (!isNum(raw.ino) || !isNum(raw.offset) || !isNum(raw.lineCount) || !isNum(raw.compactionCount)) return null;
  if (typeof raw.head !== 'string' || typeof raw.tail !== 'string' || typeof raw.truncated !== 'boolean') return null;
  if (typeof raw.thinkingEffort !== 'string') return null;
  if (!Array.isArray(raw.tools) || !Array.isArray(raw.agents) || !Array.isArray(raw.todos) || !Array.isArray(raw.taskIds)) return null;
  const state = newParseState();
  state.offset = raw.offset;
  state.lineCount = raw.lineCount;
  state.truncated = raw.truncated;
  state.compactionCount = raw.compactionCount;
  state.thinkingEffort = raw.thinkingEffort as ThinkingEffort;
  if (raw.sessionStart !== null) {
    if (!isNum(raw.sessionStart)) return null;
    state.sessionStart = new Date(raw.sessionStart);
  }
  for (const t of raw.tools) {
    if (!isRecord(t) || typeof t.id !== 'string' || !isNum(t.startTime)) return null;
    state.toolMap.set(t.id, fromSerializedTimed<ToolEntry>(t as unknown as SerializedTimed<ToolEntry>));
  }
  for (const a of raw.agents) {
    if (!isRecord(a) || typeof a.id !== 'string' || !isNum(a.startTime)) return null;
    state.agentMap.set(a.id, fromSerializedTimed<AgentEntry>(a as unknown as SerializedTimed<AgentEntry>));
  }
  for (const t of raw.todos) {
    if (!isRecord(t) || typeof t.content !== 'string') return null;
    state.todos.push(t as unknown as TodoEntry);
  }
  for (const pair of raw.taskIds) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !isNum(pair[1])) return null;
    state.taskIdToIndex.set(pair[0], pair[1]);
  }
  let subagents: SubagentsCheckpoint | null = null;
  if (isRecord(raw.subagents)) {
    const sa = raw.subagents;
    if (!Array.isArray(sa.agents)) return null;
    const dir = isRecord(sa.dir) && isNum(sa.dir.count) && isNum(sa.dir.maxMtimeMs) && isNum(sa.dir.totalSize)
      ? { count: sa.dir.count, maxMtimeMs: sa.dir.maxMtimeMs, totalSize: sa.dir.totalSize }
      : null;
    const agents: AgentEntry[] = [];
    for (const a of sa.agents) {
      if (!isRecord(a) || typeof a.id !== 'string' || !isNum(a.startTime)) return null;
      agents.push(fromSerializedTimed<AgentEntry>(a as unknown as SerializedTimed<AgentEntry>));
    }
    subagents = { dir, agents };
  }
  return { state, ino: raw.ino, head: raw.head, tail: raw.tail, subagents };
}

function checkpointPath(cacheDir: string, resolvedTranscript: string): string {
  return join(cacheDir, createHash('sha256').update(resolvedTranscript).digest('hex').slice(0, 32) + '.json');
}

// The checkpoint holds fragments of the user's tool inputs (Bash commands,
// file paths), so the directory must be private and ours, never a symlink.
function dirIsTrusted(cacheDir: string): boolean {
  try {
    const st = lstatSync(cacheDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

export function loadCheckpoint(cacheDir: string, resolvedTranscript: string): Checkpoint | null {
  try {
    if (!dirIsTrusted(cacheDir)) return null;
    const path = checkpointPath(cacheDir, resolvedTranscript);
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_CHECKPOINT_BYTES) return null;
    return deserializeCheckpoint(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function prune(cacheDir: string): void {
  try {
    const files = readdirSync(cacheDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, m: statSync(join(cacheDir, f)).mtimeMs }));
    if (files.length <= MAX_CHECKPOINT_FILES) return;
    files.sort((a, b) => a.m - b.m);
    for (const { f } of files.slice(0, files.length - MAX_CHECKPOINT_FILES)) {
      try { unlinkSync(join(cacheDir, f)); } catch { /* concurrent prune */ }
    }
  } catch { /* best effort */ }
}

export function saveCheckpoint(cacheDir: string, resolvedTranscript: string, serialized: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    if (!dirIsTrusted(cacheDir)) return;
    const path = checkpointPath(cacheDir, resolvedTranscript);
    const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, serialized);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    prune(cacheDir);
  } catch { /* checkpoint is best effort; the next tick just parses more */ }
}
