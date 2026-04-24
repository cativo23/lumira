import { createReadStream, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { TranscriptData, ToolEntry, AgentEntry, TodoEntry, TodoStatus, ThinkingEffort } from '../types.js';
import { EMPTY_TRANSCRIPT } from '../types.js';
import { isMtimeFresh, getMtimeState, type MtimeState } from '../utils/cache.js';
import { sanitizeTermString } from '../normalize.js';
import { debug } from '../utils/debug.js';

const log = debug('transcript');

interface TranscriptCacheEntry {
  result: TranscriptData;
  mtime: MtimeState;
  // Incremental parsing state — allows resuming from last byte on next tick.
  byteOffset: number;
  partialLine: string;
  toolMap: Map<string, ToolEntry>;
  agentMap: Map<string, AgentEntry>;
  todos: TodoEntry[];
  taskIdToIndex: Map<string, number>;
  thinkingEffort: ThinkingEffort;
}

const transcriptCache = new Map<string, TranscriptCacheEntry>();

const MAX_LINES = 50_000;

export function normalizeTodoStatus(status: string | undefined): TodoStatus {
  if (!status) return 'pending';
  const s = String(status).toLowerCase();
  if (s === 'completed' || s === 'done') return 'completed';
  if (s === 'in_progress' || s === 'in-progress' || s === 'running') return 'in_progress';
  return 'pending';
}

export function extractToolTarget(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const raw = (() => {
    switch (toolName) {
      case 'Read': case 'Write': case 'Edit':
        return (input.file_path ?? input.path) as string | undefined;
      case 'Glob': case 'Grep':
        return input.pattern as string | undefined;
      case 'Bash': {
        const cmd = (input.command as string) || '';
        return cmd.length > 30 ? cmd.slice(0, 30) + '...' : cmd;
      }
      default: return undefined;
    }
  })();
  return typeof raw === 'string' ? sanitizeTermString(raw) : raw;
}

/** Process a single parsed JSONL entry into the mutable state maps. */
function applyEntry(
  entry: Record<string, unknown>,
  line: string,
  result: TranscriptData,
  toolMap: Map<string, ToolEntry>,
  agentMap: Map<string, AgentEntry>,
  todos: TodoEntry[],
  taskIdToIndex: Map<string, number>,
  thinkingEffortRef: { value: ThinkingEffort },
): void {
  if (!result.sessionStart && entry.timestamp) result.sessionStart = new Date(entry.timestamp as string);

  const effortMatch = line.match(/Set model to .+ with (low|medium|high|max) effort/);
  if (effortMatch) thinkingEffortRef.value = effortMatch[1] as ThinkingEffort;

  const timestamp = entry.timestamp ? new Date(entry.timestamp as string) : new Date();
  const content = (entry as { message?: { content?: unknown } }).message?.content;
  if (!content || !Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_use' && block.id && block.name) {
      toolMap.set(block.id, { id: block.id, name: sanitizeTermString(block.name), target: extractToolTarget(block.name, block.input), status: 'running', startTime: timestamp });

      if (block.name === 'Task') {
        const inp = block.input || {};
        agentMap.set(block.id, {
          id: block.id,
          type: sanitizeTermString(inp.subagent_type || 'unknown'),
          model: typeof inp.model === 'string' ? sanitizeTermString(inp.model) : inp.model,
          description: typeof inp.description === 'string' ? sanitizeTermString(inp.description) : inp.description,
          status: 'running',
          startTime: timestamp,
        });
      }

      if (block.name === 'TodoWrite' && block.input?.todos && Array.isArray(block.input.todos)) {
        const existingById = new Map(todos.map((t: TodoEntry) => [t.id || t.content, t]));
        todos.splice(0, todos.length, ...block.input.todos.map((t: { id?: string; content?: string; status?: string }) => {
          const id = t.id || t.content || '';
          const existing = existingById.get(id);
          if (existing && (!t.status || t.status === existing.status)) return existing;
          return { id: t.id || '', content: sanitizeTermString(t.content || ''), status: normalizeTodoStatus(t.status) };
        }));
      }

      if (block.name === 'TaskCreate') {
        const inp = block.input || {};
        const todoContent = (typeof inp.subject === 'string' ? inp.subject : '') || (typeof inp.description === 'string' ? inp.description : '') || 'Untitled task';
        todos.push({ id: inp.taskId || block.id, content: sanitizeTermString(todoContent), status: normalizeTodoStatus(inp.status) });
        if (inp.taskId || block.id) taskIdToIndex.set(String(inp.taskId || block.id), todos.length - 1);
      }

      if (block.name === 'TaskUpdate') {
        const inp = block.input || {};
        let index: number | null = inp.taskId && taskIdToIndex.has(String(inp.taskId)) ? taskIdToIndex.get(String(inp.taskId))! : null;
        if (index === null && typeof inp.taskId === 'string' && /^\d+$/.test(inp.taskId)) {
          const n = parseInt(inp.taskId, 10) - 1;
          if (n >= 0 && n < todos.length) index = n;
        }
        if (index !== null && todos[index]) {
          if (inp.status) todos[index].status = normalizeTodoStatus(inp.status);
          const subj = typeof inp.subject === 'string' ? inp.subject : '';
          const desc = typeof inp.description === 'string' ? inp.description : '';
          if (subj || desc) todos[index].content = sanitizeTermString(subj || desc);
        }
      }
    }

    if (block.type === 'tool_result' && block.tool_use_id) {
      const tool = toolMap.get(block.tool_use_id);
      if (tool) { tool.status = block.is_error ? 'error' : 'completed'; tool.endTime = timestamp; }
      const agent = agentMap.get(block.tool_use_id);
      if (agent) { agent.status = 'completed'; agent.endTime = timestamp; }
    }
  }
}

/** Read new bytes from `fd` starting at `byteOffset`, returning lines + new offset + leftover partial. */
function readNewBytes(fd: number, byteOffset: number, partialLine: string): { lines: string[]; newOffset: number; newPartial: string } {
  const CHUNK = 65536;
  const buf = Buffer.allocUnsafe(CHUNK);
  let text = partialLine;
  let offset = byteOffset;

  let bytesRead: number;
  do {
    bytesRead = readSync(fd, buf, 0, CHUNK, offset);
    if (bytesRead > 0) {
      text += buf.subarray(0, bytesRead).toString('utf8');
      offset += bytesRead;
    }
  } while (bytesRead === CHUNK);

  const rawLines = text.split('\n');
  const partial = rawLines.pop() ?? '';
  return { lines: rawLines, newOffset: offset, newPartial: partial };
}

export async function parseTranscript(transcriptPath: string): Promise<TranscriptData> {
  const result: TranscriptData = { ...EMPTY_TRANSCRIPT, tools: [], agents: [], todos: [] };
  if (!transcriptPath || !existsSync(transcriptPath)) {
    if (log.enabled) log('skip — transcript path missing or nonexistent:', transcriptPath || '(empty)');
    return result;
  }

  const resolved = resolve(transcriptPath);
  if (!resolved.startsWith(homedir()) && !resolved.startsWith(tmpdir())) {
    log('skip — path outside allowed roots:', resolved);
    return result;
  }

  const currentMtime = getMtimeState(transcriptPath);
  const cached = transcriptCache.get(resolved);

  // Full cache hit — mtime + size unchanged.
  if (currentMtime && cached && isMtimeFresh(transcriptPath, cached.mtime)) {
    log('cache hit:', resolved);
    return cached.result;
  }

  const parseStart = log.enabled ? Date.now() : 0;

  // Detect truncation (file shrank) — must full-reparse.
  const prevOffset = cached?.byteOffset ?? 0;
  const fileShrunk = currentMtime && prevOffset > currentMtime.size;

  const toolMap: Map<string, ToolEntry> = fileShrunk || !cached ? new Map() : new Map(cached.toolMap);
  const agentMap: Map<string, AgentEntry> = fileShrunk || !cached ? new Map() : new Map(cached.agentMap);
  const todos: TodoEntry[] = fileShrunk || !cached ? [] : [...cached.todos];
  const taskIdToIndex: Map<string, number> = fileShrunk || !cached ? new Map() : new Map(cached.taskIdToIndex);
  const thinkingEffortRef = { value: (fileShrunk || !cached ? '' : cached.thinkingEffort) as ThinkingEffort };
  const startOffset = fileShrunk || !cached ? 0 : prevOffset;
  const startPartial = fileShrunk || !cached ? '' : cached.partialLine;

  // Carry over sessionStart from prior parse if available.
  if (!fileShrunk && cached?.result.sessionStart) result.sessionStart = cached.result.sessionStart;

  let newOffset = startOffset;
  let newPartial = startPartial;
  let lineCount = 0;

  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const { lines, newOffset: off, newPartial: partial } = readNewBytes(fd, startOffset, startPartial);
    newOffset = off;
    newPartial = partial;

    for (const line of lines) {
      if (!line.trim()) continue;
      if (++lineCount > MAX_LINES) break;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        applyEntry(entry, line, result, toolMap, agentMap, todos, taskIdToIndex, thinkingEffortRef);
      } catch { /* skip malformed */ }
    }
  } catch { /* partial results */ } finally {
    if (fd !== null) try { closeSync(fd); } catch {}
  }

  result.tools = Array.from(toolMap.values()).slice(-20);
  result.agents = Array.from(agentMap.values()).slice(-10);
  result.todos = todos;
  result.thinkingEffort = thinkingEffortRef.value;

  if (currentMtime) {
    transcriptCache.set(resolved, {
      result,
      mtime: currentMtime,
      byteOffset: newOffset,
      partialLine: newPartial,
      toolMap,
      agentMap,
      todos: [...todos],
      taskIdToIndex,
      thinkingEffort: thinkingEffortRef.value,
    });
  }

  if (log.enabled) {
    log('parsed', resolved, {
      tools: result.tools.length,
      agents: result.agents.length,
      todos: result.todos.length,
      thinkingEffort: result.thinkingEffort || null,
      incremental: startOffset > 0 && !fileShrunk,
      durationMs: Date.now() - parseStart,
    });
  }
  return result;
}
