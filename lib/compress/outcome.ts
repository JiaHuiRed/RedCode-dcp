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

    if (max !== undefined && after > max) {
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
