import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { getModelInfo, resolveContextLimits } from "../messages/inject/utils"
import { getCurrentTokenUsage } from "../token-utils"

function fmt(n: number): string {
    const v = Math.max(0, Math.round(n))
    return v >= 1000 ? `~${(v / 1000).toFixed(1)}K` : `~${v}`
}

// 260831 cc: compress 此前只回「Compressed N messages」——压掉 3K 和压掉 180K 返回同一句话，
// 模型无从判断自己这次压了个寂寞，也就没有理由继续压。哥哥 08-30 在家实测：250K 压完仍是
// 250K，模型汇报「已经把最近块压缩了」就收工，人工提醒一句才压到 70K。
// 量本来就是算好的（CompressionBlock.compressedTokens / summaryTokens），这里回给模型。
export function formatCompressionOutcome(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    compressedTokens: number,
    summaryTokens: number,
    options?: { saturated?: boolean },
): string {
    const net = compressedTokens - summaryTokens
    const parts: string[] = [
        `Removed ${fmt(compressedTokens)} tokens of history at a summary cost of ${fmt(summaryTokens)} (net ${net >= 0 ? "saving" : "increase"} ${fmt(Math.abs(net))}).`,
    ]

    // 上报用量为 0：会话开头或主仓 compaction 之后，没有可信基线就不猜阈值状态。
    const before = getCurrentTokenUsage(state, messages)
    if (before <= 0) {
        if (net <= 0) {
            parts.push("This compression did not reduce context.")
        }
        return parts.join(" ")
    }

    const after = Math.max(0, before - net)
    parts.push(`Context was ${fmt(before)}, now ${fmt(after)}.`)

    const { providerId, modelId } = getModelInfo(messages)
    const { min, max } = resolveContextLimits(config, state, providerId, modelId)
    // 260903 cc: 恢复目标是 min 不是 max —— 压到 max 上就收手会贴着触发线，两轮后又过线。
    // 与 inject.ts 的 resolveRecoveryTarget 必须同源，否则工具说"够了"而提醒还在催。
    const target = min ?? max

    if (state.nudges.recovering && target !== undefined && after > target) {
        if (options?.saturated) {
            // 260914 Red: 本轮已覆盖全部剩余可压历史（覆盖率 ≥95%，见 range.ts），上下文里
            // 剩下的都是压不动的部分（系统提示、工具 schema、受保护内容、已有块）。此时再
            // 喊「继续压」只会换来一次无意义的微型压缩 + 缓存重建，如实收尾。
            parts.push(
                "This pass covered the entire remaining compressible history, so the context is already as small as compression can make it — the rest is system prompt, tool schemas, protected content and existing blocks.",
                "Report the situation instead of compressing again.",
            )
        } else {
            parts.push(
                `STILL ABOVE the ${fmt(target)} recovery target${max !== undefined && after > max ? ` (and the ${fmt(max)} emergency threshold)` : ""} - you must remove about ${fmt(after - target)} more.`,
                "Select another range starting at the OLDEST uncompressed message and compress again now.",
                "Do not report completion yet.",
            )
        }
    } else if (max !== undefined && after > max) {
        parts.push(
            `STILL ABOVE the ${fmt(max)} emergency threshold - older uncompressed history remains.`,
            "Select another range starting at the OLDEST uncompressed message and compress again now.",
            "Do not report completion yet.",
        )
    } else if (min !== undefined && after >= min) {
        parts.push(
            `Below the emergency threshold but still above ${fmt(min)} - more closed history can be compressed.`,
        )
    } else if (net <= 0) {
        parts.push("This compression did not reduce context.")
    }

    return parts.join(" ")
}
