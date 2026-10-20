import { truncField, truncAnsi, displayWidth, safeCols } from './text.js';
import { SEP, EXCLUDED_TOOLS, getCustomCommandsForLine, renderCustomCommand } from './shared.js';
function buildToolPieces(tools, c, ic) {
    const relevant = tools.filter(t => !EXCLUDED_TOOLS.has(t.name));
    const pieces = [];
    // What is running now outlives the history: the first running tool is the
    // last thing to go, and the only one that gets shortened instead of dropped.
    const running = relevant.filter(t => t.status === 'running').slice(-2);
    running.forEach((tool, i) => {
        const target = tool.target ? `: ${truncField(tool.target, 14)}` : '';
        const label = `◐ ${tool.name}${target}`;
        pieces.push({ group: 'tools', text: c.yellow(label), priority: i === 0 ? 100 : 80, shorten: max => c.yellow(truncField(label, max)) });
    });
    const completed = relevant.filter(t => t.status === 'completed');
    const groups = new Map();
    for (const tool of completed) {
        groups.set(tool.name, (groups.get(tool.name) ?? 0) + 1);
    }
    const topGroups = Array.from(groups.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);
    // Completed groups are history: they go first, least-used before most-used.
    topGroups.forEach(([name, count], i) => {
        const countStr = count > 1 ? ` ×${count}` : '';
        const label = `${ic.checkmark} ${name}${countStr}`;
        pieces.push({ group: 'tools', text: c.dim(label), priority: 50 - i, shorten: max => c.dim(truncField(label, max)) });
    });
    return pieces;
}
function buildAgentsPart(agents, c, ic) {
    const running = agents.filter(a => a.status === 'running').length;
    if (running < 1)
        return '';
    const label = running === 1 ? '1 agent' : `${running} agents`;
    return c.yellow(`${ic.bolt}${label}`);
}
function buildTodosPart(todos, c, ic) {
    if (todos.length === 0)
        return '';
    const total = todos.length;
    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const pending = todos.filter(t => t.status === 'pending').length;
    const SEGMENTS = 10;
    const filledCount = Math.round((completed / total) * SEGMENTS);
    const bar = c.green(ic.barFull.repeat(filledCount)) + c.dim(ic.barEmpty.repeat(SEGMENTS - filledCount));
    let str = `${bar} ${completed}/${total}`;
    if (inProgress > 0)
        str += ` ${c.yellow(`◐ ${inProgress}`)}`;
    if (pending > 0)
        str += ` ${c.dim(`○ ${pending}`)}`;
    return str;
}
export function renderLine3(ctx, c) {
    const { transcript: { tools, todos, agents }, config: { display }, icons } = ctx;
    const pieces = display.tools === false ? [] : buildToolPieces(tools, c, icons);
    const agentsPart = display.agents === false ? '' : buildAgentsPart(agents, c, icons);
    if (agentsPart)
        pieces.push({ group: 'agents', text: agentsPart, priority: 85, shorten: max => truncAnsi(agentsPart, max) });
    const todosPart = display.todos === false ? '' : buildTodosPart(todos, c, icons);
    if (todosPart)
        pieces.push({ group: 'todos', text: todosPart, priority: 90, shorten: max => truncAnsi(todosPart, max) });
    // Custom commands (issue #143 phase 3) — appended after the core line3
    // widgets so they sit at the end of the line and are visible without
    // disrupting the tools/agents/todos cluster. Lowest priority: they evict
    // first, the last one before the earlier ones.
    getCustomCommandsForLine(ctx.customCommands, 3).forEach((out, i) => {
        const seg = renderCustomCommand(out, c);
        if (seg)
            pieces.push({ group: `custom-${i}`, text: seg, priority: 10 - i / 100, shorten: max => truncAnsi(seg, max) });
    });
    return fitPieces(pieces, safeCols(ctx.cols));
}
function joinPieces(pieces) {
    const groups = [];
    let current = '';
    for (const p of pieces) {
        if (p.group !== current || groups.length === 0) {
            groups.push([]);
            current = p.group;
        }
        groups[groups.length - 1].push(p.text);
    }
    return groups.map(g => g.join(' ')).join(SEP);
}
// Drop the lowest-priority piece until the line fits; a single piece that is
// still too wide is shortened rather than wrapping the statusline.
function fitPieces(pieces, safe) {
    const kept = [...pieces];
    let line = joinPieces(kept);
    while (kept.length > 1 && displayWidth(line) > safe) {
        let lowest = 0;
        for (let i = 1; i < kept.length; i++)
            if (kept[i].priority < kept[lowest].priority)
                lowest = i;
        kept.splice(lowest, 1);
        line = joinPieces(kept);
    }
    if (kept.length === 1 && displayWidth(line) > safe)
        return kept[0].shorten(safe);
    return line;
}
//# sourceMappingURL=line3.js.map