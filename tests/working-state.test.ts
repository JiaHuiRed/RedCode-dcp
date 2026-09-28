import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import type { SelectionResolution } from "../lib/compress/types"
import {
    buildWorkingState,
    formatWorkingState,
    parseWorkingState,
    workingStateSize,
} from "../lib/compress/working-state"

function buildState(entries: Record<string, { tool: string; input: unknown; status?: string; error?: string }>): SessionState {
    const state = createSessionState()
    for (const [callId, entry] of Object.entries(entries)) {
        state.toolParameters.set(callId, {
            tool: entry.tool,
            parameters: entry.input,
            status: entry.status as "pending" | "running" | "completed" | "error" | undefined,
            error: entry.error,
            turn: 1,
        })
    }
    return state
}

function buildSelection(toolIds: string[], messageIds: string[] = []): SelectionResolution {
    return {
        startReference: { kind: "message", rawIndex: 0 },
        endReference: { kind: "message", rawIndex: 1 },
        messageIds,
        messageTokenById: new Map(),
        toolIds,
        requiredBlockIds: [],
    }
}

function userMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "ses",
            agent: "assistant",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "ses",
                type: "text" as const,
                text,
            },
        ],
    }
}

test("buildWorkingState extracts edited files, failed calls and user prompts", () => {
    const state = buildState({
        "call-edit": { tool: "edit", input: { filePath: "src/a.ts" }, status: "completed" },
        "call-write": { tool: "write", input: { filePath: "src/a.ts" }, status: "completed" },
        "call-read": { tool: "read", input: { filePath: "src/b.ts" }, status: "completed" },
        "call-bash": { tool: "bash", input: { command: "cat src/a.ts" }, status: "completed" },
        "call-err": {
            tool: "bash",
            input: { command: "bun test" },
            status: "error",
            error: "1 fail\nsecond line dropped",
        },
    })
    const messages = [userMessage("msg-user-1", "Fix the bug\nin src/a.ts")]

    const workingState = buildWorkingState(
        state,
        buildSelection(["call-edit", "call-write", "call-read", "call-bash", "call-err"], ["msg-user-1"]),
        messages,
    )

    assert.ok(workingState)
    // write 与 edit 指向同一文件 → 去重；read/bash 不算动过文件
    assert.deepEqual(workingState.filesTouched, ["src/a.ts"])
    assert.equal(workingState.failedCalls.length, 1)
    assert.equal(workingState.failedCalls[0]!.tool, "bash")
    assert.ok(workingState.failedCalls[0]!.error.startsWith("1 fail"))
    assert.ok(!workingState.failedCalls[0]!.error.includes("second line"))
    assert.deepEqual(workingState.userPrompts, ["Fix the bug"])
})

test("buildWorkingState returns undefined when selection has nothing notable", () => {
    const state = buildState({
        "call-read": { tool: "read", input: { filePath: "src/b.ts" }, status: "completed" },
    })
    const workingState = buildWorkingState(
        state,
        buildSelection(["call-read"], []),
        [userMessage("msg-user-1", "hello")],
    )
    assert.equal(workingState, undefined)
})

test("buildWorkingState enforces the hard budget by dropping prompts, then files, then failures", () => {
    const longPath = "src/" + "x".repeat(40) + ".ts"
    const entries: Record<string, { tool: string; input: unknown; status?: string; error?: string }> = {}
    for (let i = 0; i < 30; i++) {
        entries[`call-${i}`] = { tool: "edit", input: { filePath: `src/${longPath}-${i}` }, status: "completed" }
    }
    entries["call-err"] = {
        tool: "bash",
        input: { command: "bun test" },
        status: "error",
        error: "boom",
    }
    const state = buildState(entries)
    const prompts = ["p1", "p2", "p3", "p4", "p5"].map((p, i) => userMessage(`msg-user-${i}`, p))
    const workingState = buildWorkingState(
        state,
        buildSelection(Object.keys(entries), prompts.map((m) => m.info.id)),
        prompts,
    )

    assert.ok(workingState)
    assert.ok(workingStateSize(workingState) <= 1024, "snapshot must stay within 1024 chars")
    // 丢弃顺序：userPrompts 全丢、filesTouched 丢尾部，failedCalls 保留到最后
    assert.equal(workingState.userPrompts.length, 0)
    assert.equal(workingState.failedCalls.length, 1)
    assert.ok(workingState.filesTouched.length > 0)
    assert.ok(workingState.filesTouched.length < 30)
})

test("formatWorkingState renders sections for the injected summary text", () => {
    const text = formatWorkingState({
        filesTouched: ["src/a.ts"],
        failedCalls: [{ tool: "bash", input: `{"command":"bun test"}`, error: "boom" }],
        userPrompts: ["Fix the bug"],
    })
    assert.ok(text.includes("Working state (mechanically extracted):"))
    assert.ok(text.includes("Files touched: src/a.ts"))
    assert.ok(text.includes("Failed: bash — boom"))
    assert.ok(text.includes("- Fix the bug"))
})

test("parseWorkingState round-trips and rejects empty/malformed payloads", () => {
    const workingState = {
        filesTouched: ["src/a.ts"],
        failedCalls: [{ tool: "bash", input: "cmd", error: "boom" }],
        userPrompts: ["Fix the bug"],
    }
    assert.deepEqual(parseWorkingState(JSON.parse(JSON.stringify(workingState))), workingState)

    assert.equal(parseWorkingState(undefined), undefined)
    assert.equal(parseWorkingState("nope"), undefined)
    assert.equal(
        parseWorkingState({ filesTouched: [], failedCalls: [], userPrompts: [] }),
        undefined,
    )
    // 结构化字段损坏时丢坏条目，保留合法部分
    const partial = parseWorkingState({
        filesTouched: ["ok", 42],
        failedCalls: ["junk", { tool: "bash" }],
        userPrompts: ["kept"],
    })
    assert.ok(partial)
    assert.deepEqual(partial.filesTouched, ["ok"])
    assert.deepEqual(partial.failedCalls, [{ tool: "bash", input: "", error: "" }])
    assert.deepEqual(partial.userPrompts, ["kept"])
})
