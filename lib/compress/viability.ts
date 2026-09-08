import type { SessionState } from "../state"
import { countTokens } from "../token-utils"
import type { SelectionResolution } from "./types"

/**
 * 压缩得先还得起本钱。
 *
 * 260903 cc: 实测 ses_ffe5f9fca1 一个会话压了 9 次，其中两次是**净增**——
 * 一次压掉 7183 token 却写了 10296 token 的摘要，另一次压掉 **20** token 写了 140。
 * 两次都照常入库、照常把前缀缓存打掉。之所以会这样：紧急档反复催「还在线上，立刻再压」，
 * 而模型手上已经没有值得压的东西了，就随手圈一段交差。
 *
 * 这里在落库前拦掉。两条判据都不需要调参：
 * 1. 摘要不比它替换掉的内容小 —— 定义上就不该做。
 * 2. 选中范围本身太小 —— 即使摘要更小，为了几百 token 打掉整条前缀缓存也不划算。
 *
 * ⚠️ **只在紧急档恢复期间生效**（`state.nudges.recovering`）。手动压缩、收益档压缩都不拦：
 * 用户明说要压一小段是他的决定，收益档压单条消息几百 token 也是那个模式的既定粒度。
 * 要拦的是"被提醒逼着交差"这一种，而它只在恢复期间发生。
 */
const MIN_SELECTION_TOKENS = 1000

export interface ViabilityInput {
    selection: SelectionResolution
    summary: string
}

export interface ViabilityFailure {
    startId: string
    endId: string
    selectionTokens: number
    summaryTokens: number
    reason: "too-small" | "no-saving" | "insufficient-recovery"
    requiredNetSavings?: number
    actualNetSavings?: number
}

/**
 * 本次压缩**新**产生的收益：已经在活跃块里的消息再压一遍不产生任何节省。
 *
 * 口径与 applyCompressionState 里的 compressedTokens 一致（只计从「不在活跃块」变成
 * 「在活跃块」的那些），否则会把嵌套压缩重复计成收益、把不划算的一次算成划算。
 */
export function estimateNewlyCompressedTokens(
    state: SessionState,
    selection: SelectionResolution,
): number {
    let total = 0
    for (const messageId of selection.messageIds) {
        const entry = state.prune.messages.byMessageId.get(messageId)
        if (entry && entry.activeBlockIds.length > 0) {
            continue
        }
        total += selection.messageTokenById.get(messageId) ?? 0
    }
    return total
}

/**
 * `enforceMinimum` 只对 range 模式开。
 *
 * message 模式一个 plan 就是**一条消息**，几百 token 是它的既定粒度，套 1000 的下限
 * 会把这个模式整个否掉。「摘要比它替换的还大」那条两个模式都该拦。
 */
export function checkViability(
    state: SessionState,
    startId: string,
    endId: string,
    selection: SelectionResolution,
    summary: string,
    options?: { enforceMinimum?: boolean; summaryTokens?: number },
): ViabilityFailure | undefined {
    if (!state.nudges.recovering) {
        return undefined
    }

    const selectionTokens = estimateNewlyCompressedTokens(state, selection)
    const summaryTokens = options?.summaryTokens ?? countTokens(summary)

    if (options?.enforceMinimum !== false && selectionTokens < MIN_SELECTION_TOKENS) {
        return { startId, endId, selectionTokens, summaryTokens, reason: "too-small" }
    }

    if (summaryTokens >= selectionTokens) {
        return { startId, endId, selectionTokens, summaryTokens, reason: "no-saving" }
    }

    return undefined
}

/**
 * 紧急恢复不是“有一点收益就算完成”：一次成功的 range 必须真的够回到目标线。
 *
 * 日常收益档仍可按小任务压缩；这里只有 `recovering` 时才会检查总净收益。先在所有
 * range 的摘要都补全后再验，既支持一次调用里的多个不重叠 range，也能按实际摘要成本算。
 */
export function checkRecoveryBudget(
    state: SessionState,
    startId: string,
    endId: string,
    selectionTokens: number,
    summaryTokens: number,
    requiredNetSavings: number,
): ViabilityFailure | undefined {
    if (!state.nudges.recovering || requiredNetSavings <= 0) {
        return undefined
    }

    const actualNetSavings = selectionTokens - summaryTokens
    if (actualNetSavings >= requiredNetSavings) {
        return undefined
    }

    return {
        startId,
        endId,
        selectionTokens,
        summaryTokens,
        reason: "insufficient-recovery",
        requiredNetSavings,
        actualNetSavings,
    }
}

function fmt(n: number): string {
    return n >= 1000 ? `~${(n / 1000).toFixed(1)}K` : `~${n}`
}

/** 拒绝理由回给模型，说清为什么以及下一步该怎么选，别让它原样重试。 */
export function formatViabilityRejection(failures: ViabilityFailure[]): string {
    const lines = failures.map((failure) => {
        const where = `${failure.startId}..${failure.endId}`
        if (failure.reason === "too-small") {
            return `- ${where}: only ${fmt(failure.selectionTokens)} tokens of uncompressed history. Compressing it costs a full prefix-cache reset and saves almost nothing.`
        }
        if (failure.reason === "insufficient-recovery") {
            return `- ${where}: this batch would net ${fmt(failure.actualNetSavings ?? 0)}, but recovery needs ${fmt(failure.requiredNetSavings ?? 0)}. No block was written, so no prefix cache was reset.`
        }
        return `- ${where}: your summary is ${fmt(failure.summaryTokens)} tokens but replaces only ${fmt(failure.selectionTokens)} - it would make context larger, not smaller.`
    })

    return [
        "Compression rejected - the selected range(s) cannot complete a worthwhile recovery:",
        ...lines,
        "Select a substantially larger range starting at the OLDEST uncompressed message. In recovery, one successful call must cover the full remaining budget. If no such range is left, stop compressing and report that the remaining history is already compressed.",
    ].join("\n")
}
