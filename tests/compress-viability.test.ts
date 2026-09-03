import assert from "node:assert/strict"
import test from "node:test"
import { checkViability, estimateNewlyCompressedTokens } from "../lib/compress/viability"
import { createSessionState } from "../lib/state"
import type { SessionState } from "../lib/state"
import type { SelectionResolution } from "../lib/compress/types"

// 260903 cc: 两个形状都取自实测 ses_ffe5f9fca1（一个会话压了 9 次）：
//   block 7 —— 压掉 7183 token，摘要 10296，净 -3113
//   block 9 —— 压掉 20 token，摘要 140，净 -120
// 两次都照常入库、照常打掉整条前缀缓存。

function buildSelection(tokensById: Record<string, number>): SelectionResolution {
    const messageIds = Object.keys(tokensById)
    return {
        startReference: { kind: "message", rawIndex: 0, messageId: messageIds[0] },
        endReference: { kind: "message", rawIndex: messageIds.length - 1, messageId: messageIds.at(-1) },
        messageIds,
        messageTokenById: new Map(Object.entries(tokensById)),
        toolIds: [],
        requiredBlockIds: [],
    } as unknown as SelectionResolution
}

function recoveringState(): SessionState {
    const state = createSessionState()
    state.nudges.recovering = true
    return state
}

// 摘要按 4 字符 ≈ 1 token 造，够粗但方向稳定
const summaryOf = (approxTokens: number) => "x ".repeat(approxTokens * 2)

test("rejects a summary larger than the history it replaces (block 7 的形状)", () => {
    const state = recoveringState()
    const selection = buildSelection({ m1: 4000, m2: 3183 })
    const failure = checkViability(state, "m0001", "m0009", selection, summaryOf(10_296))

    assert.ok(failure)
    assert.equal(failure.reason, "no-saving")
})

test("rejects a degenerate tiny range (block 9 的形状)", () => {
    const state = recoveringState()
    const selection = buildSelection({ m1: 20 })
    const failure = checkViability(state, "m0031", "m0031", selection, summaryOf(140))

    assert.ok(failure)
    assert.equal(failure.reason, "too-small")
})

test("accepts a range that actually pays", () => {
    const state = recoveringState()
    const selection = buildSelection({ m1: 40_000, m2: 38_000 })
    assert.equal(checkViability(state, "m0001", "m0040", selection, summaryOf(2_000)), undefined)
})

test("does not gate outside emergency recovery", () => {
    // 手动压一小段、收益档压单条消息都不该被拦——要拦的是被提醒逼着交差那一种
    const state = createSessionState()
    assert.equal(state.nudges.recovering, false)
    const selection = buildSelection({ m1: 20 })
    assert.equal(checkViability(state, "m0031", "m0031", selection, summaryOf(140)), undefined)
})

test("already-compressed messages contribute no new saving", () => {
    const state = recoveringState()
    state.prune.messages.byMessageId.set("m1", {
        tokenCount: 50_000,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const selection = buildSelection({ m1: 50_000, m2: 900 })

    // m1 已在活跃块里，再压一遍不产生新收益；口径与 applyCompressionState 一致
    assert.equal(estimateNewlyCompressedTokens(state, selection), 900)
    const failure = checkViability(state, "m0001", "m0009", selection, summaryOf(100))
    assert.ok(failure)
    assert.equal(failure.reason, "too-small")
})
