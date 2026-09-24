import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { detectModelLimitMiss, reportModelLimitMiss } from "../lib/messages/inject/utils"
import { createSessionState, type WithParts } from "../lib/state"

function buildConfig(overrides: Partial<PluginConfig["compress"]> = {}): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
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
            maxContextLimit: 100000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            absoluteNudgeThreshold: 20000,
            absoluteNudgeFrequency: 15,
            protectedTools: [],
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

const providerId = "openai"
const modelId = "large-model"

test("empty or missing model tables warn only for known large context windows", () => {
    for (const limits of [{}, { modelMaxLimits: {}, modelMinLimits: {} }]) {
        const config = buildConfig(limits)
        assert.deepEqual(detectModelLimitMiss(config, providerId, modelId, 1_000_000), {
            key: "openai/large-model",
            thresholds: ["max", "min"],
            sameModelKeys: [],
        })
        assert.equal(detectModelLimitMiss(config, providerId, modelId, 499_999), undefined)
        assert.equal(detectModelLimitMiss(config, providerId, modelId, undefined), undefined)
    }
})

test("existing nonempty-table warning remains independent of context size", () => {
    const config = buildConfig({ modelMaxLimits: { "other/large-model": 200000 } })
    assert.deepEqual(detectModelLimitMiss(config, providerId, modelId, 128_000), {
        key: "openai/large-model",
        thresholds: ["max"],
        sameModelKeys: ["other/large-model"],
    })
    assert.deepEqual(detectModelLimitMiss(config, providerId, modelId, 1_000_000)?.thresholds, ["max", "min"])
})

test("empty-table miss is surfaced once per session when context size becomes known", async () => {
    const state = createSessionState()
    const config = buildConfig()
    const toasts: string[] = []
    const client = {
        tui: {
            showToast: async ({ body }: { body: { message: string } }) => {
                toasts.push(body.message)
            },
        },
    }
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-1",
                role: "user",
                sessionID: "ses-1",
                agent: "build",
                model: { providerID: providerId, modelID: modelId },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [{ id: "part-1", messageID: "msg-1", sessionID: "ses-1", type: "text", text: "hi" }],
        },
    ]

    await reportModelLimitMiss(client, new Logger(false), config, state, messages)
    assert.equal(toasts.length, 0)

    state.modelContextLimit = 1_000_000
    await reportModelLimitMiss(client, new Logger(false), config, state, messages)
    await reportModelLimitMiss(client, new Logger(false), config, state, messages)
    assert.equal(toasts.length, 1)
    assert.match(toasts[0]!, /modelMaxLimits.*modelMinLimits/)
})
