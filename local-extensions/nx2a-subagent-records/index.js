/**
 * nx2a-subagent-records — 认领那些没跑完就被掐断的子代理。
 *
 * 子代理是跟着会话活的：玩家切到别的会话（或开新会话），引擎会把那个会话里正在跑的子代理
 * 掐掉。引擎自己只在「跑完」时写一条记录，被掐的那一次于是既没有记录，也不再有谁写它。
 * 手机那边只能从「有 transcript 没记录」推出「还在跑」，它就永远显示在跑——面板上转着圈，
 * 助手也查不到它做过什么。
 *
 * 这个扩展在会话打开时把这种孤儿认领下来，往会话里补一条「已中断」的记录：面板与助手从此
 * 对同一次运行有同一个说法，助手也查得到它被中断过、做到哪一步（transcript 还在）。
 *
 * 它只读引擎自己写的文件（会话里的记录、临时目录里的 transcript），只往会话里追加自己的
 * 那一条记录——不碰引擎的数据，也不改任何运行的状态。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 引擎给跑完的子代理写的记录，它的 customType。 */
const RECORD_TYPE = "subagents:record";

/** 被中断的状态：手机那边认它为「已中断」。 */
const STATUS = "interrupted";

/** 中断的理由：会话被换掉了，或者进程没了——不必猜是哪一种，两种都说得通。 */
const REASON = "cut off before it finished (the session was replaced, or the app went away)";

/** transcript 里一条用户消息的记号：一次运行一条（跟手机那边数运行次的方式一样）。 */
const RUN_MARK = '"type":"user"';

export default function (pi) {
    pi.on("session_start", (_event, ctx) => {
        try {
            adopt(pi, ctx);
        }
        catch (err) {
            // 认领失败不该把会话拖垮：这一次的运行只是还缺一条记录而已
            console.warn("[nx2a] the interrupted runs were not adopted:", err);
        }
    });
}

/**
 * 把这个会话里「有 transcript、没有收尾记录」的运行次补成「已中断」。
 *
 * 一个子代理可以跑好几轮（续跑），transcript 里一轮一条用户消息，引擎跑完一轮写一条记录：
 * 两边一比就知道缺了几轮——缺的那些就是被掐断的。
 */
function adopt(pi, ctx) {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId)
        return;
    const dirs = taskDirs(sessionId);
    if (dirs.length === 0)
        return;
    const recorded = recordedRuns(ctx);
    for (const dir of dirs) {
        for (const name of readdirSync(dir)) {
            if (!name.endsWith(".output"))
                continue;
            const path = join(dir, name);
            const id = name.slice(0, -".output".length);
            const starts = runStarts(path);
            const have = recorded.get(id) ?? 0;
            if (starts.length <= have)
                continue;
            const spawn = spawnCall(ctx, id, path);
            const endedAt = Math.round(statSync(path).mtimeMs);
            for (let index = have; index < starts.length; index++) {
                pi.appendEntry(RECORD_TYPE, {
                    id,
                    type: spawn?.arguments?.subagent_type ?? "",
                    description: spawn?.arguments?.description ?? "",
                    status: STATUS,
                    error: REASON,
                    startedAt: starts[index],
                    completedAt: endedAt,
                });
            }
        }
    }
}

/**
 * 这个会话的 transcript 都在哪儿。
 *
 * 引擎把它们放在临时目录里：<tmp>/pi-subagents-<uid>/<编码过的工作目录>/<会话 id>/tasks。
 * 工作目录会变（隔离工作树里的子代理跑在别处），所以每个编码过的目录都看一眼。
 */
function taskDirs(sessionId) {
    const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
    const dirs = [];
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    }
    catch {
        return dirs;   // 引擎还没写过 transcript
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const tasks = join(root, entry.name, sessionId, "tasks");
        try {
            if (statSync(tasks).isDirectory())
                dirs.push(tasks);
        }
        catch {
            // 那个编码下没有这一段会话
        }
    }
    return dirs;
}

/** 会话里已经写了几条记录（按子代理 id 数）：引擎跑完一次写一条。 */
function recordedRuns(ctx) {
    const counts = new Map();
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
        if (entry?.type !== "custom" || entry?.customType !== RECORD_TYPE)
            continue;
        const id = entry?.data?.id;
        if (typeof id !== "string" || id === "")
            continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
}

/**
 * 每一轮开始的时刻：transcript 里一条用户消息 = 一轮。
 *
 * 记号数出来的轮数跟手机那边数的一样（那边也是数这个记号），所以两边对「缺了几轮」的
 * 判断一致——记号落在正文里的那种极少见的偏差，两边会一起偏。
 */
function runStarts(path) {
    const text = readFileSync(path, "utf-8");
    const starts = [];
    for (const line of text.split("\n")) {
        let count = 0;
        let at = line.indexOf(RUN_MARK);
        while (at >= 0) {
            count++;
            at = line.indexOf(RUN_MARK, at + RUN_MARK.length);
        }
        if (count === 0)
            continue;
        const stamp = timestampOf(line);
        for (let i = 0; i < count; i++)
            starts.push(stamp);
    }
    return starts;
}

/** 一条 transcript 消息的时刻（毫秒）。 */
function timestampOf(line) {
    const match = /"timestamp":"([^"]+)"/.exec(line);
    if (!match)
        return 0;
    const parsed = Date.parse(match[1]);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 派生它的那次调用：类型与描述从那儿来（面板上那个牌子就是它）。
 *
 * 引擎在派生结果里写了子代理的 id 与 transcript 的路径，找到那次调用就认出了它。
 */
function spawnCall(ctx, id, path) {
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    const calls = new Map();
    let spawn;
    for (const entry of entries) {
        const message = entry?.message;
        const parts = Array.isArray(message?.content) ? message.content : [];
        for (const part of parts) {
            if (part?.type === "toolCall" && typeof part.id === "string")
                calls.set(part.id, part);
        }
        if (message?.role !== "toolResult")
            continue;
        const text = parts.map(part => part?.text ?? "").join("\n");
        if (!text.includes(`Agent ID: ${id}`) && !text.includes(path))
            continue;
        spawn = calls.get(message.toolCallId) ?? spawn;
    }
    return spawn;
}
