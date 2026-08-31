import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { formatCompressionOutcome } from "../lib/compress/outcome"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state"
import { sumCompressSavings } from "../lib/state/utils"

function buildConfig(maxContextLimit: number, minContextLimit: number): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: false,
            maxContextLimit,
            minContextLimit,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

// 只放助手消息：没有 user 消息时 getModelInfo 返回 undefined/undefined，
// 触发线走全局值，不用为每模型查表铺夹具。
function reportedUsage(totalInput: number): WithParts[] {
    const sessionID = "ses_compress_outcome"
    return [
        {
            info: {
                id: "msg-assistant",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
                tokens: {
                    input: totalInput,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-assistant-part",
                    messageID: "msg-assistant",
                    sessionID,
                    type: "text" as const,
                    text: "reply",
                },
            ],
        },
    ]
}

function block(
    compressMessageId: string,
    compressedTokens: number,
    summaryTokens: number,
    blockId: number,
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens,
        summaryTokens,
        durationMs: 0,
        mode: "range",
        topic: "topic",
        batchTopic: "topic",
        startId: "m0001",
        endId: "m0009",
        anchorMessageId: "msg-anchor",
        compressMessageId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: "summary",
    }
}

test("compression outcome tells the model it is still above the emergency threshold", () => {
    const state = createSessionState()
    const config = buildConfig(220_000, 150_000)

    // 250K 上下文只压掉 4K：正是哥哥 08-30 在家遇到的那种「压了个寂寞」。
    const result = formatCompressionOutcome(state, config, reportedUsage(249_999), 4_000, 1_000)

    assert.ok(result.includes("net saving"))
    assert.ok(result.includes("STILL ABOVE"))
    assert.ok(result.includes("OLDEST uncompressed message"))
    assert.ok(result.includes("Do not report completion yet."))
})

test("compression outcome stops pushing once the context drops below both thresholds", () => {
    const state = createSessionState()
    const config = buildConfig(220_000, 150_000)

    // 250K 压到 70K：哥哥人工提醒后那次的量级。
    const result = formatCompressionOutcome(state, config, reportedUsage(249_999), 200_000, 20_000)

    assert.ok(result.includes("Context was"))
    assert.ok(!result.includes("STILL ABOVE"))
    assert.ok(!result.includes("Do not report completion yet."))
})

test("compression outcome reports a net increase instead of claiming a saving", () => {
    const state = createSessionState()
    const config = buildConfig(220_000, 150_000)

    const result = formatCompressionOutcome(state, config, reportedUsage(999), 10, 100)

    assert.ok(result.includes("net increase"))
    assert.ok(result.includes("This compression did not reduce context."))
})

test("isContextOverLimits subtracts savings that the reported usage cannot see yet", () => {
    const state = createSessionState()
    const config = buildConfig(220_000, 150_000)
    const messages = reportedUsage(249_999)

    const before = isContextOverLimits(config, state, undefined, undefined, messages)
    assert.equal(before.overMaxLimit, true)

    // 压缩要到下一次请求才落地，上报用量仍是压缩前的 250K——不扣减就会把一次成功的
    // 大压缩误判成还在紧急档。
    const after = isContextOverLimits(config, state, undefined, undefined, messages, 180_000)
    assert.equal(after.overMaxLimit, false)
    assert.equal(after.overMinLimit, false)
})

test("sumCompressSavings counts only the blocks from one compress message, net of summary cost", () => {
    const state = createSessionState()
    const messagesState = state.prune.messages

    messagesState.blocksById.set(1, block("msg-a", 5_000, 1_000, 1))
    messagesState.blocksById.set(2, block("msg-a", 3_000, 500, 2))
    messagesState.blocksById.set(3, block("msg-b", 9_000, 2_000, 3))
    messagesState.activeBlockIds.add(1)
    messagesState.activeBlockIds.add(2)
    messagesState.activeBlockIds.add(3)

    assert.equal(sumCompressSavings(state, "msg-a"), 6_500)
    assert.equal(sumCompressSavings(state, "msg-b"), 7_000)
    assert.equal(sumCompressSavings(state, "msg-none"), 0)
})
