import assert from "node:assert/strict"
import test from "node:test"
import { resolveContextConfig } from "../lib/context-config"
import { boundedJson, createRetrievalTools, readMessageWindow, utf8Prefix } from "../lib/context-retrieval"
import { createSessionState, resetSessionState, type CompressionBlock, type WithParts } from "../lib/state"
import { wrapCompressedSummary } from "../lib/compress/state"
import { appendMissingBlockSummaries, injectBlockPlaceholders, parseBlockPlaceholders, resolveCondensedSummaries } from "../lib/compress/range-utils"
import { createEconomicsState, estimateEconomics, loadEconomicsState, recordEconomics, syncEconomics } from "../lib/compression-economics"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { ToolContext } from "../lib/compress/types"
import { hasMatchingToolPermission, resolveEffectiveToolPermission } from "../lib/host-permissions"
import { countTokens } from "../lib/token-utils"

function config(): PluginConfig {
    return {
        enabled: true, debug: false, pruneNotification: "off", pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range", permission: "allow", showCompression: false,
            maxContextLimit: 150000, minContextLimit: 50000, nudgeFrequency: 5,
            iterationNudgeThreshold: 15, nudgeForce: "soft", protectedTools: [],
            protectTags: true, protectUserMessages: true,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function block(id: number, body: string, known = true): CompressionBlock {
    return {
        blockId: id, runId: id, active: true, deactivatedByUser: false, durationMs: 0,
        compressedTokens: 10000, summaryTokens: 500, topic: "Archived work",
        startId: "m0001", endId: "m0002", anchorMessageId: "raw-1", compressMessageId: "compress-1",
        includedBlockIds: [], consumedBlockIds: [], parentBlockIds: [],
        directMessageIds: ["raw-1"], directToolIds: [], effectiveMessageIds: ["raw-1"],
        effectiveToolIds: [], createdAt: 1, summary: wrapCompressedSummary(id, body),
        protectedContentKnown: known,
    }
}

function message(text: string, id = "raw-1"): WithParts {
    return {
        info: { id, role: "user", sessionID: "session-a", agent: "build", model: { providerID: "test", modelID: "test" }, time: { created: 1 } },
        parts: [{ id: "part-1", messageID: id, sessionID: "session-a", type: "text", text }],
    } as WithParts
}

function retrieval(messages: WithParts[], host = { global: undefined, agents: {} } as Parameters<typeof createRetrievalTools>[1]) {
    const state = createSessionState()
    state.sessionId = "session-a"
    state.messageIds.byRawId.set("raw-1", "m0001")
    state.messageIds.byRef.set("m0001", "raw-1")
    const ctx: ToolContext = {
        state, config: config(), logger: new Logger(false),
        client: { session: { messages: async () => ({ data: messages }) } },
        prompts: { reload() {}, getRuntimePrompts() { return { compressRange: "", compressMessage: "" } } } as ToolContext["prompts"],
    }
    const call = {
        sessionID: "session-a", messageID: "tool-message", agent: "build", directory: ".", worktree: ".",
        abort: new AbortController().signal, metadata() {}, ask: async () => {},
    }
    return { state, ctx, call, tools: createRetrievalTools(ctx, host) }
}

test("context configuration has validated file-backed defaults and rates", () => {
    const limits = resolveContextConfig()
    assert.equal(limits.maxOutputBytes, 8192)
    assert.equal(limits.maxOutputTokens, 2048)
    assert.equal(limits.ledgerMaxEntries, 128)
    for (const input of [{ maxOutputBytes: 1000000 }, { maxResults: -1 }, { maxResults: null }, { unknown: 1 }, { rates: { x: { currency: "USD" } } }]) {
        assert.throws(() => resolveContextConfig(input))
    }
})

test("condensation shortens all injection paths while preserving protected tails and archived sources", () => {
    const tail = "The following user messages were sent in this conversation verbatim:\nKeep the exact contract.\n\nThe following protected tools were used in this conversation as well:\nTool evidence."
    const original = block(1, "Long old narrative. ".repeat(100) + "\n\n" + tail)
    const blocks = new Map([[1, original]])
    const before = JSON.stringify(original)
    const condensed = resolveCondensedSummaries({ b1: "Completed earlier work." }, [1], blocks, 8192)
    const start = { kind: "message" as const, rawIndex: 0, messageId: "raw-1" }
    const end = { kind: "message" as const, rawIndex: 1, messageId: "raw-2" }
    const injected = injectBlockPlaceholders("Previous (b1)", parseBlockPlaceholders("Previous (b1)"), blocks, start, end, condensed)
    assert.match(injected.expandedSummary, /Completed earlier work/)
    assert.doesNotMatch(injected.expandedSummary, /Long old narrative/)
    assert.ok(injected.expandedSummary.includes(tail))
    assert.deepEqual(injected.consumedBlockIds, [1])
    const boundary = injectBlockPlaceholders("New work", [], blocks, { kind: "compressed-block", blockId: 1, rawIndex: 0 }, end, condensed)
    assert.ok(boundary.expandedSummary.includes(tail))
    assert.match(boundary.expandedSummary, /Completed earlier work/)
    const missing = appendMissingBlockSummaries("New work", [1], blocks, [], condensed)
    assert.ok(missing.expandedSummary.includes(tail))
    assert.doesNotMatch(missing.expandedSummary, /Long old narrative/)
    assert.equal(JSON.stringify(original), before)
    assert.throws(() => resolveCondensedSummaries({ b2: "Unknown" }, [1], blocks, 8192))
    assert.throws(() => resolveCondensedSummaries({ b1: "" }, [1], blocks, 8192))
    assert.throws(() => resolveCondensedSummaries({ b1: "(b1)" }, [1], blocks, 8192))
})

test("legacy blocks without a protection manifest retain their original body", () => {
    const original = block(1, "Unknown old protection layout.", false)
    delete original.protectedContentKnown
    const blocks = new Map([[1, original]])
    assert.match(resolveCondensedSummaries({ b1: "short" }, [1], blocks, 8192).get(1)!, /Unknown old protection/)
    const result = injectBlockPlaceholders("(b1)", parseBlockPlaceholders("(b1)"), blocks,
        { kind: "message", messageId: "raw-1", rawIndex: 0 }, { kind: "message", messageId: "raw-2", rawIndex: 1 })
    assert.match(result.expandedSummary, /Unknown old protection/)
})

test("read windows continue past the scan limit without concatenating skipped content", () => {
    const item = message("x".repeat(2000000) + "late detail")
    const window = readMessageWindow(item, 2000000, 11, 8192)
    assert.equal(window.text, "late detail")
    assert.equal(window.totalLength, 2000011)
    assert.throws(() => readMessageWindow(message("a🙂b"), 2, 10, 8192), /Unicode/)
    assert.equal(utf8Prefix("中🙂next", 4), "中")
    const multipart = message("中🙂")
    multipart.parts.push({ id: "part-2", messageID: "raw-1", sessionID: "session-a", type: "text", text: "later" })
    assert.equal(readMessageWindow(multipart, 0, 20, 4).text, "中")
})

test("whole retrieval JSON obeys UTF-8 and token budgets including metadata", () => {
    const limits = resolveContextConfig({ maxOutputBytes: 512, maxOutputTokens: 128 })
    const output = boundedJson({ results: [{ ref: "m0001", offset: 0, text: "语境🙂".repeat(1000) }], truncated: false }, limits)
    assert.ok(Buffer.byteLength(output) <= 512)
    assert.ok(countTokens(output) <= limits.maxOutputTokens)
    const parsed = JSON.parse(output)
    assert.equal(parsed.truncated, true)
    assert.ok(parsed.results.length)
    assert.equal(parsed.results[0].nextOffset, parsed.results[0].text.length)
})

test("retrieval searches inactive archives and reads originals without changing history", async () => {
    const f = retrieval([message("Original searchable needle and exact command")])
    const archived = block(1, "Archived needle")
    archived.active = false
    f.state.prune.messages.blocksById.set(1, archived)
    const before = JSON.stringify([...f.state.prune.messages.blocksById.values()])
    const search = JSON.parse(await f.tools.dcp_search.execute({ query: "needle" }, f.call))
    assert.deepEqual(search.results.map((item: { ref: string }) => item.ref), ["b1", "m0001"])
    const read = JSON.parse(await f.tools.dcp_read.execute({ ref: "m0001", offset: 9, limit: 10 }, f.call))
    assert.equal(read.results[0].text, "searchable")
    assert.equal(read.results[0].truncated, true)
    const old = JSON.parse(await f.tools.dcp_read.execute({ ref: "b1" }, f.call))
    assert.match(old.results[0].text, /Archived needle/)
    assert.equal(JSON.stringify([...f.state.prune.messages.blocksById.values()]), before)
    await assert.rejects(() => f.tools.dcp_read.execute({ ref: "m9999" }, f.call), /unavailable/)
    await assert.rejects(() => f.tools.dcp_read.execute({ ref: "../../secret" }, f.call), /Invalid/)
})

test("retrieval rejects deny, subagents, and session changes during permission and fetch", async () => {
    const denied = retrieval([message("private")], { global: { "dcp_*": "deny" }, agents: {} })
    await assert.rejects(() => denied.tools.dcp_search.execute({ query: "private" }, denied.call), /denied/)
    assert.equal(hasMatchingToolPermission({ "dcp_*": "deny" }, "dcp_read"), true)
    assert.equal(resolveEffectiveToolPermission("dcp_read", "allow", { global: {}, agents: { build: { "dcp_*": "deny" } } }, "build"), "deny")
    const child = retrieval([message("private")])
    child.state.isSubAgent = true
    await assert.rejects(() => child.tools.dcp_read.execute({ ref: "m0001" }, child.call), /subagents/)
    const switched = retrieval([message("private")])
    switched.call.ask = async () => { switched.state.sessionId = "other" }
    await assert.rejects(() => switched.tools.dcp_read.execute({ ref: "m0001" }, switched.call), /changed/)
    const duringFetch = retrieval([message("private")])
    duringFetch.ctx.client.session.messages = async () => { duringFetch.state.sessionId = "other"; return { data: [message("private")] } }
    await assert.rejects(() => duringFetch.tools.dcp_search.execute({ query: "private" }, duringFetch.call), /changed/)
})

test("economics deduplicates receipts, labels unknown costs and bounds per-session records", () => {
    const state = createSessionState()
    const limits = resolveContextConfig({ ledgerMaxEntries: 2 })
    for (let id = 1; id <= 4; id++) {
        const entry = { runId: id, messageId: `compress-${id}`, blockIds: [id], inputTokensEstimated: 10000, summaryTokensEstimated: 100 }
        recordEconomics(state, entry, limits)
        recordEconomics(state, entry, limits)
    }
    assert.equal(state.economics!.entries.length, 2)
    assert.equal(state.economics!.partial, true)
    assert.equal(estimateEconomics(state, state.economics!.entries[0]!).actualSavings, "unknown")
    resetSessionState(state)
    assert.deepEqual(state.economics, createEconomicsState())
})

test("economics records whole generating usage, forecasts cached payback and restores validated rates", () => {
    const state = createSessionState()
    const rates = { currency: "USD", input: 2, cacheRead: 0.2, cacheWrite: 2, output: 8, reasoning: 8 }
    const limits = resolveContextConfig({ rates: { "test/model": rates } })
    state.prune.messages.blocksById.set(1, block(1, "Current summary"))
    recordEconomics(state, { runId: 1, messageId: "generator", blockIds: [1], inputTokensEstimated: 10000, summaryTokensEstimated: 1000 }, limits)
    const entry = state.economics!.entries[0]!
    entry.createdAt = 10
    const usage = (id: string, time: number): WithParts => ({
        info: { id, role: "assistant", sessionID: "session-a", providerID: "test", modelID: "model",
            time: { created: time, completed: time + 1 },
            tokens: { input: 100, output: 20, reasoning: 30, cache: { read: 10000, write: 0 } } },
        parts: [],
    } as WithParts)
    assert.equal(syncEconomics(state, [usage("generator", 1), usage("next", 11)], limits), true)
    assert.equal(syncEconomics(state, [usage("generator", 1), usage("next", 11)], limits), false)
    const estimate = estimateEconomics(state, entry)
    assert.equal(estimate.status, "estimated")
    assert.equal(estimate.actualSavings, "unknown")
    if (estimate.status !== "estimated") throw new Error("Missing configured estimate")
    assert.equal(estimate.wholeTurnCost, (100 * 2 + 10000 * 0.2 + 20 * 8 + 30 * 8) / 1e6)
    assert.equal(estimate.perCachedRequestBenefit, 9000 * 0.2 / 1e6)
    assert.ok(estimate.breakEvenRequests)
    const restored = loadEconomicsState(JSON.parse(JSON.stringify(state.economics)))
    assert.deepEqual(restored.entries[0]!.rates, rates)
    state.prune.messages.blocksById.get(1)!.active = false
    assert.equal(estimateEconomics(state, entry).status, "unknown")
    assert.deepEqual(loadEconomicsState(undefined), createEconomicsState())
})
