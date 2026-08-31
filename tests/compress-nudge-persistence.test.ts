import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock, SessionState } from "../lib/state"
import type { RuntimePrompts } from "../lib/prompts/store"

function buildConfig(overrides?: Partial<PluginConfig["compress"]>): PluginConfig {
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
            maxContextLimit: 220000,
            minContextLimit: 150000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            absoluteNudgeThreshold: 20000,
            absoluteNudgeFrequency: 15,
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            ...overrides,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

const prompts: RuntimePrompts = {
    system: "",
    compressRange: "",
    compressMessage: "",
    contextLimitNudge: "EMERGENCY CONTEXT REMINDER",
    turnNudge: "",
    iterationNudge: "",
    absoluteNudge: "",
    manualExtension: "",
    subagentExtension: "",
}

const SESSION = "ses_compress_nudge_persistence"
const ASSISTANT_ID = "msg-assistant-compressed"

// user + 一条带 completed compress 工具调用的助手消息：模型刚压完那一轮的形状。
function buildJustCompressedMessages(reportedInput: number): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID: SESSION,
                agent: "assistant",
                time: { created: 1 },
                model: { providerID: "anthropic", modelID: "claude-test" },
            } as unknown as WithParts["info"],
            parts: [
                {
                    id: "msg-user-1-part",
                    messageID: "msg-user-1",
                    sessionID: SESSION,
                    type: "text" as const,
                    text: "go",
                },
            ],
        },
        {
            info: {
                id: ASSISTANT_ID,
                role: "assistant",
                sessionID: SESSION,
                agent: "assistant",
                time: { created: 2 },
                tokens: { input: reportedInput, output: 100 },
            } as unknown as WithParts["info"],
            parts: [
                {
                    id: `${ASSISTANT_ID}-text`,
                    messageID: ASSISTANT_ID,
                    sessionID: SESSION,
                    type: "text" as const,
                    text: "compressed the most recent block",
                },
                {
                    id: `${ASSISTANT_ID}-tool`,
                    messageID: ASSISTANT_ID,
                    sessionID: SESSION,
                    type: "tool" as const,
                    tool: "compress",
                    callID: "call-1",
                    state: { status: "completed" as const, output: "ok" },
                } as unknown as WithParts["parts"][number],
            ],
        },
    ]
}

function seedBlock(state: SessionState, compressedTokens: number, summaryTokens: number): void {
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
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
        anchorMessageId: ASSISTANT_ID,
        compressMessageId: ASSISTANT_ID,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "summary",
    }
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)
}

test("an ineffective compress does not silence the emergency nudge", () => {
    // 250K 上下文，这次 compress 只净省 3K —— 哥哥 08-30 在家遇到的形状。
    const messages = buildJustCompressedMessages(249_900)
    const state = createSessionState()
    seedBlock(state, 4_000, 1_000)
    state.nudges.turnNudgeAnchors.add(ASSISTANT_ID)
    state.nudges.absoluteNudgeAnchors.add(ASSISTANT_ID)

    injectCompressNudges(state, buildConfig(), new Logger(false), messages, prompts)

    // 紧急档必须留着，并且实际注入到当前最后一条消息上。
    assert.equal(state.nudges.contextLimitAnchors.has(ASSISTANT_ID), true)
    const text = messages[1]!.parts.find((p: any) => p.type === "text") as any
    assert.ok(text.text.includes("EMERGENCY CONTEXT REMINDER"))

    // 非紧急三档照旧让位，避免连环催。
    assert.equal(state.nudges.turnNudgeAnchors.size, 0)
    assert.equal(state.nudges.absoluteNudgeAnchors.size, 0)
})

test("an effective compress clears the emergency nudge", () => {
    // 同样 250K，但这次净省 200K —— 哥哥人工提醒后那次的量级。
    const messages = buildJustCompressedMessages(249_900)
    const state = createSessionState()
    seedBlock(state, 220_000, 20_000)
    state.nudges.contextLimitAnchors.add(ASSISTANT_ID)

    injectCompressNudges(state, buildConfig(), new Logger(false), messages, prompts)

    assert.equal(state.nudges.contextLimitAnchors.size, 0)
    const text = messages[1]!.parts.find((p: any) => p.type === "text") as any
    assert.ok(!text.text.includes("EMERGENCY CONTEXT REMINDER"))
})
