import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { finalizeSession, type NotificationEntry } from "../lib/compress/pipeline"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import { createSessionState, type CompressionBlock } from "../lib/state"

const logger = new Logger(false)
const config = {
    pruneNotification: "off",
    manualMode: { enabled: false },
} as PluginConfig

function block(id: number, input: number, summary: number, consumed: number[] = []): CompressionBlock {
    return {
        blockId: id,
        runId: 9,
        active: true,
        deactivatedByUser: false,
        compressedTokens: input,
        summaryTokens: summary,
        durationMs: 0,
        mode: "range",
        topic: "private topic",
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "private-anchor",
        compressMessageId: "private-message",
        includedBlockIds: consumed,
        consumedBlockIds: consumed,
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "private summary",
    }
}

async function finalize(blocks: CompressionBlock[], selected: number[]) {
    const state = createSessionState()
    for (const item of blocks) state.prune.messages.blocksById.set(item.blockId, item)
    const updates: unknown[] = []
    const entries: NotificationEntry[] = selected.map((id) => ({
        blockId: id,
        runId: 9,
        summary: "private summary",
        summaryTokens: state.prune.messages.blocksById.get(id)!.summaryTokens,
    }))
    await finalizeSession(
        { client: {}, state, logger, config, prompts: new PromptStore(logger, ".", false) },
        { sessionID: "test-evidence", ask: async () => {}, metadata: (value) => updates.push(value) },
        [],
        entries,
        "private topic",
    )
    return updates
}

test("finalization emits scalar estimates without summary or source text", async () => {
    const updates = await finalize([block(1, 10_000, 1_000)], [1])
    assert.deepEqual(updates, [{
        metadata: {
            dcpCompression: {
                version: 1,
                runId: 9,
                blockCount: 1,
                inputTokensEstimated: 10_000,
                summaryTokensEstimated: 1_000,
                netSavingsEstimated: 9_000,
            },
        },
    }])
    assert.ok(!JSON.stringify(updates).includes("private"))
})

test("nested compression counts the removed old summary, not its original source again", async () => {
    const updates = await finalize([block(1, 50_000, 2_000), block(2, 5_000, 3_000, [1])], [2])
    assert.deepEqual(updates, [{
        metadata: {
            dcpCompression: {
                version: 1,
                runId: 9,
                blockCount: 1,
                inputTokensEstimated: 7_000,
                summaryTokensEstimated: 3_000,
                netSavingsEstimated: 4_000,
            },
        },
    }])
})

test("a batch counts each consumed summary only once", async () => {
    const updates = await finalize([
        block(1, 50_000, 2_000),
        block(2, 5_000, 1_000, [1]),
        block(3, 3_000, 1_000, [1]),
    ], [2, 3])
    assert.deepEqual(updates, [{
        metadata: {
            dcpCompression: {
                version: 1,
                runId: 9,
                blockCount: 2,
                inputTokensEstimated: 10_000,
                summaryTokensEstimated: 2_000,
                netSavingsEstimated: 8_000,
            },
        },
    }])
})

test("negative estimated savings remain negative", async () => {
    const updates = await finalize([block(1, 100, 1_000)], [1])
    assert.deepEqual(updates, [{
        metadata: {
            dcpCompression: {
                version: 1,
                runId: 9,
                blockCount: 1,
                inputTokensEstimated: 100,
                summaryTokensEstimated: 1_000,
                netSavingsEstimated: -900,
            },
        },
    }])
})

test("no completed blocks emits no compression event", async () => {
    assert.deepEqual(await finalize([], []), [])
})
