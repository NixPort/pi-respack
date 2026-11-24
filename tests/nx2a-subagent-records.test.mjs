// tests/nx2a-subagent-records.test.mjs — 伴生扩展的认领逻辑。
//
// 用法：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../local-extensions/nx2a-subagent-records/index.js";

/** 一个假的引擎：收下扩展挂上的钩子，记下它追加的记录。 */
function fakePi() {
    const handlers = {};
    const appended = [];
    return {
        handlers,
        appended,
        api: {
            on(event, handler) {
                handlers[event] = handler;
            },
            appendEntry(type, data) {
                appended.push({ type, data });
            },
        },
    };
}

/** 一段 transcript：一条用户消息 = 一轮。 */
function transcript(path, rounds) {
    const lines = [];
    for (let i = 0; i < rounds; i++) {
        lines.push(JSON.stringify({
            isSidechain: true,
            agentId: "agent-1",
            type: "user",
            message: { role: "user", content: `task ${i}` },
            timestamp: `2026-11-24T06:0${i}:00.000Z`,
            cwd: "/tmp/work",
        }));
        lines.push(JSON.stringify({
            isSidechain: true,
            agentId: "agent-1",
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "working" }] },
            timestamp: `2026-11-24T06:0${i}:30.000Z`,
            cwd: "/tmp/work",
        }));
    }
    writeFileSync(path, lines.join("\n") + "\n");
}

/** 把一段 transcript 放进引擎那样的临时目录。 */
function putTranscript(root, sessionId, name, rounds) {
    const dir = join(root, `pi-subagents-${process.getuid?.() ?? 0}`, "work", sessionId, "tasks");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    transcript(path, rounds);
    return path;
}

/** 会话文件：引擎自己的账本（跑完的记录与派生它们的调用都在里面）。 */
function sessionFile(root, sessionId, lines = []) {
    const path = join(root, `${sessionId}.jsonl`);
    const header = JSON.stringify({
        type: "session", version: 3, id: sessionId, timestamp: "2026-11-24T06:00:00.000Z", cwd: "/tmp/work",
    });
    writeFileSync(path, [header, ...lines.map(line => JSON.stringify(line))].join("\n") + "\n");
    return path;
}

/** 引擎交给扩展的那个上下文。 */
function fakeCtx(sessionId, file) {
    return {
        cwd: "/tmp/work",
        sessionManager: {
            getSessionId: () => sessionId,
            getSessionFile: () => file,
            getBranch: () => [],
        },
    };
}

/** 引擎写下的那条记录。 */
function record(id) {
    return { type: "custom", customType: "subagents:record", data: { id } };
}

/** 派生它的那次调用与它的结果。 */
function spawn(id) {
    return [
        {
            type: "message",
            message: {
                role: "assistant",
                content: [{
                    type: "toolCall",
                    id: "call-1",
                    name: "Agent",
                    arguments: { subagent_type: "gamespec", description: "fix the crash" },
                }],
            },
        },
        {
            type: "message",
            message: {
                role: "toolResult",
                toolCallId: "call-1",
                content: [{ type: "text", text: `Agent started in background.\nAgent ID: ${id}\n` }],
            },
        },
    ];
}

/** 跑一次认领：造好现场，让扩展认领，返回它追加的记录。 */
function run(root, { sessionId = "sess-1", rounds = 1, lines = [] } = {}) {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
        putTranscript(root, sessionId, "agent-1.output", rounds);
        const file = sessionFile(root, sessionId, lines);
        const pi = fakePi();
        extension(pi.api);
        pi.handlers.session_start({}, fakeCtx(sessionId, file));
        return pi.appended;
    }
    finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
    }
}

test("a transcript without a record is adopted as interrupted", () => {
    const appended = run(mkdtempSync(join(tmpdir(), "nx2a-test-")));
    assert.equal(appended.length, 1);
    assert.equal(appended[0].type, "subagents:record");
    assert.equal(appended[0].data.id, "agent-1");
    assert.equal(appended[0].data.status, "interrupted");
    assert.equal(appended[0].data.startedAt, Date.parse("2026-11-24T06:00:00.000Z"));
    assert.ok(appended[0].data.error.length > 0);
});

test("the spawn call gives the run its type and its task", () => {
    const appended = run(mkdtempSync(join(tmpdir(), "nx2a-test-")), { lines: spawn("agent-1") });
    assert.equal(appended[0].data.type, "gamespec");
    assert.equal(appended[0].data.description, "fix the crash");
});

test("a finished run is left alone", () => {
    const appended = run(mkdtempSync(join(tmpdir(), "nx2a-test-")), { lines: [record("agent-1")] });
    assert.equal(appended.length, 0);
});

test("only the missing rounds of a resumed agent are adopted", () => {
    const appended = run(mkdtempSync(join(tmpdir(), "nx2a-test-")), {
        rounds: 2,
        lines: [record("agent-1")],
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].data.startedAt, Date.parse("2026-11-24T06:01:00.000Z"));
});

test("another session's transcripts are not touched", () => {
    const root = mkdtempSync(join(tmpdir(), "nx2a-test-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
        putTranscript(root, "sess-other", "agent-2.output", 1);
        const file = sessionFile(root, "sess-1");
        const pi = fakePi();
        extension(pi.api);
        pi.handlers.session_start({}, fakeCtx("sess-1", file));
        assert.equal(pi.appended.length, 0);
    }
    finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
    }
});
