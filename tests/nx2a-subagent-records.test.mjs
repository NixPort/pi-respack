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

/** 引擎交给扩展的那个上下文。 */
function fakeCtx(sessionId, branch = []) {
    return {
        cwd: "/tmp/work",
        sessionManager: {
            getSessionId: () => sessionId,
            getSessionFile: () => `/tmp/sessions/${sessionId}.jsonl`,
            getBranch: () => branch,
        },
    };
}

test("a transcript without a record is adopted as interrupted", () => {
    const root = mkdtempSync(join(tmpdir(), "nx2a-test-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
        putTranscript(root, "sess-1", "agent-1.output", 1);
        const pi = fakePi();
        extension(pi.api);
        pi.handlers.session_start({}, fakeCtx("sess-1"));
        assert.equal(pi.appended.length, 1);
        assert.equal(pi.appended[0].type, "subagents:record");
        assert.equal(pi.appended[0].data.id, "agent-1");
        assert.equal(pi.appended[0].data.status, "interrupted");
        assert.equal(pi.appended[0].data.startedAt, Date.parse("2026-11-24T06:00:00.000Z"));
        assert.ok(pi.appended[0].data.error.length > 0);
    }
    finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
    }
});

test("a finished run is left alone", () => {
    const root = mkdtempSync(join(tmpdir(), "nx2a-test-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
        putTranscript(root, "sess-1", "agent-1.output", 1);
        const branch = [{ type: "custom", customType: "subagents:record", data: { id: "agent-1" } }];
        const pi = fakePi();
        extension(pi.api);
        pi.handlers.session_start({}, fakeCtx("sess-1", branch));
        assert.equal(pi.appended.length, 0);
    }
    finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
    }
});

test("only the missing rounds of a resumed agent are adopted", () => {
    const root = mkdtempSync(join(tmpdir(), "nx2a-test-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
        putTranscript(root, "sess-1", "agent-1.output", 2);
        const branch = [{ type: "custom", customType: "subagents:record", data: { id: "agent-1" } }];
        const pi = fakePi();
        extension(pi.api);
        pi.handlers.session_start({}, fakeCtx("sess-1", branch));
        assert.equal(pi.appended.length, 1);
        assert.equal(pi.appended[0].data.startedAt, Date.parse("2026-11-24T06:01:00.000Z"));
    }
    finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
    }
});

test("another session's transcripts are not touched", () => {
    const root = mkdtempSync(join(tmpdir(), "nx2a-test-"));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
        putTranscript(root, "sess-other", "agent-2.output", 1);
        const pi = fakePi();
        extension(pi.api);
        pi.handlers.session_start({}, fakeCtx("sess-1"));
        assert.equal(pi.appended.length, 0);
    }
    finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
    }
});
