import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { createSessionState, type WithParts } from "../lib/state"
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
            maxContextLimit: 100000,
            minContextLimit: 50000,
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

function buildMessage(
    id: string,
    role: "user" | "assistant",
    sessionID: string,
    tokens?: number,
): WithParts {
    const info: Record<string, any> = {
        id,
        role,
        sessionID,
        agent: "assistant",
        time: { created: 1 },
    }
    if (role === "user") {
        info.model = { providerID: "anthropic", modelID: "claude-test" }
    } else if (tokens !== undefined) {
        info.tokens = { input: tokens, output: 100 }
    }
    return {
        info: info as WithParts["info"],
        parts: [{ id: `${id}-part`, messageID: id, sessionID, type: "text" as const, text: "hi" }],
    }
}

const prompts: RuntimePrompts = {
    system: "",
    compressRange: "",
    compressMessage: "",
    contextLimitNudge: "",
    turnNudge: "",
    iterationNudge: "",
    absoluteNudge: `Base absolute nudge`,
    manualExtension: "",
    subagentExtension: "",
}

test("absolute nudge anchors when tokens pass threshold and below min limit", () => {
    const sessionID = "ses_absolute_nudge_trigger"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID),
        buildMessage("msg-assistant-1", "assistant", sessionID, 25000),
    ]
    const state = createSessionState()
    const config = buildConfig({ absoluteNudgeThreshold: 20000, absoluteNudgeFrequency: 5 })
    const logger = new Logger(false)

    injectCompressNudges(state, config, logger, messages, prompts)

    assert.equal(state.nudges.absoluteNudgeAnchors.has("msg-assistant-1"), true)
    const lastPart = messages[1]!.parts[messages[1]!.parts.length - 1] as any
    assert.match(lastPart.text, /Base absolute nudge/)
})

test("absolute nudge does not anchor below threshold", () => {
    const sessionID = "ses_absolute_nudge_below"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID),
        buildMessage("msg-assistant-1", "assistant", sessionID, 5000),
    ]
    const state = createSessionState()
    const config = buildConfig({ absoluteNudgeThreshold: 20000, absoluteNudgeFrequency: 5 })
    const logger = new Logger(false)

    injectCompressNudges(state, config, logger, messages, prompts)

    assert.equal(state.nudges.absoluteNudgeAnchors.size, 0)
})

test("absolute nudge yields when context passes min limit", () => {
    const sessionID = "ses_absolute_nudge_min"
    const messages: WithParts[] = [
        buildMessage("msg-user-1", "user", sessionID),
        buildMessage("msg-assistant-1", "assistant", sessionID, 60000),
    ]
    const state = createSessionState()
    state.nudges.absoluteNudgeAnchors.add("msg-assistant-1")
    const config = buildConfig({ minContextLimit: 50000, absoluteNudgeThreshold: 20000 })
    const logger = new Logger(false)

    injectCompressNudges(state, config, logger, messages, prompts)

    assert.equal(state.nudges.absoluteNudgeAnchors.size, 0)
})
