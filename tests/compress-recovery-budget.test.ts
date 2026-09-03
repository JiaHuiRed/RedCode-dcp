import assert from "node:assert/strict"
import test from "node:test"
import { buildRecoveryBudgetGuidance } from "../lib/prompts/extensions/nudge"

// 260903 cc: 预算表要回答的就是"从最老那条往后累计到哪个 ID 才够"，
// 此前提示词只说 "as far forward as is safely possible"，模型手上只有不透明的 mNNNN。

function ledger(count: number, tokensEach: number) {
    return Array.from({ length: count }, (_, index) => ({
        ref: `m${String(index + 1).padStart(4, "0")}`,
        tokens: tokensEach,
    }))
}

test("marks the smallest range that covers the deficit", () => {
    // 缺口 100K，每条 10K：累计到第 10 条正好够
    const text = buildRecoveryBudgetGuidance({
        currentTokens: 250_000,
        target: 150_000,
        uncompressed: ledger(30, 10_000),
    })

    assert.ok(text.includes("must remove at least ~100.0K"))
    const marked = text.split("\n").filter((line) => line.includes("<- smallest range"))
    assert.equal(marked.length, 1)
    assert.ok(marked[0]!.includes("m0001..m0010"), marked[0])
    assert.ok(text.includes("Use m0001 as startId"))
})

test("stays compact on a long history", () => {
    const text = buildRecoveryBudgetGuidance({
        currentTokens: 250_000,
        target: 150_000,
        uncompressed: ledger(400, 500),
    })
    // 400 条历史不能铺成 400 行
    assert.ok(text.split("\n").length <= 15, `too many lines: ${text.split("\n").length}`)
})

test("emits nothing when already at target or nothing left to compress", () => {
    assert.equal(
        buildRecoveryBudgetGuidance({
            currentTokens: 140_000,
            target: 150_000,
            uncompressed: ledger(10, 10_000),
        }),
        "",
    )
    assert.equal(
        buildRecoveryBudgetGuidance({
            currentTokens: 250_000,
            target: 150_000,
            uncompressed: [],
        }),
        "",
    )
})

// --- 预算表只挂最后一个锚 ---------------------------------------------------

import type { PluginConfig } from "../lib/config"
import type { RuntimePrompts } from "../lib/prompts/store"
import { applyAnchoredNudges } from "../lib/messages/inject/utils"
import { createSessionState, type WithParts } from "../lib/state"

const SESSION = "ses_recovery_budget"

function message(id: string, role: "user" | "assistant"): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: SESSION,
            agent: "assistant",
            time: { created: 1 },
            ...(role === "assistant" ? { tokens: { input: 250_000, output: 10 } } : {}),
        } as unknown as WithParts["info"],
        parts: [
            {
                id: `${id}-text`,
                messageID: id,
                sessionID: SESSION,
                type: "text" as const,
                text: "body",
            },
        ],
    }
}

function budgetConfig(): PluginConfig {
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
            maxContextLimit: 220_000,
            minContextLimit: 150_000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            absoluteNudgeThreshold: 20_000,
            absoluteNudgeFrequency: 15,
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    } as PluginConfig
}

const budgetPrompts: RuntimePrompts = {
    system: "",
    compressRange: "",
    compressMessage: "",
    contextLimitNudge: "<dcp-system-reminder>EMERGENCY</dcp-system-reminder>",
    turnNudge: "",
    iterationNudge: "",
    absoluteNudge: "",
    manualExtension: "",
    subagentExtension: "",
}

test("the budget rides only on the newest anchor", () => {
    // 锚是累积的；预算表里的当前用量每轮在变。挂在老锚上会让它往后的前缀每轮作废，
    // 那就是在修缓存问题的同时制造一个新的缓存问题。
    const messages = [message("m-1", "user"), message("m-2", "assistant"), message("m-3", "assistant")]
    const state = createSessionState()
    state.nudges.recovering = true
    state.nudges.contextLimitAnchors.add("m-1")
    state.nudges.contextLimitAnchors.add("m-3")

    applyAnchoredNudges(state, budgetConfig(), messages, budgetPrompts, undefined, {
        currentTokens: 250_000,
        target: 150_000,
        uncompressed: ledger(20, 10_000),
    })

    const textOf = (m: WithParts) =>
        m.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")

    assert.ok(textOf(messages[0]!).includes("EMERGENCY"))
    assert.ok(!textOf(messages[0]!).includes("RECOVERY BUDGET"), "老锚不该带预算表")
    assert.ok(textOf(messages[2]!).includes("RECOVERY BUDGET"), "最后一个锚该带预算表")
})
