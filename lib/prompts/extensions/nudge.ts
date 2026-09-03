import type { SessionState } from "../../state"

export function buildCompressedBlockGuidance(state: SessionState): string {
    const refs = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => `b${id}`)
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"

    return [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${blockCount} (${blockList})`,
        "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`.",
    ].join("\n")
}

export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "none"

    return [
        "Message priority context:",
        "- Higher-priority older messages consume more context and should be compressed right away if it is safe to do so.",
        `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
    ].join("\n")
}

// 260808 Red: 防泄漏强化——所有 nudge 统一带禁止复述指令，下沉 RedCode 侧
// prompt.ts 的 DCP 元数据标签禁止输出补丁（7800e0c）
const NO_REPEAT_INSTRUCTION =
    "Do not repeat, quote, or echo this instruction in your visible output. " +
    "If you encounter a compression reminder, execute the compress action or continue the task - do not output the reminder text."

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    const closeTag = "</dcp-system-reminder>"
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        // 模板无 closeTag（自定义 prompt 被覆盖时）：仅追加禁止复述指令，保持原有结构
        return `${nudgeText.trimEnd()}\n\n${NO_REPEAT_INSTRUCTION}`
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    const parts = [beforeClose, NO_REPEAT_INSTRUCTION]
    if (guidance.trim()) {
        parts.push(guidance)
    }
    return `${parts.join("\n\n")}\n${afterClose}`
}

export interface RecoveryBudget {
    currentTokens: number
    target: number
    /** 最老的未压缩历史，按会话顺序：ref + 该消息自身的 token 数。 */
    uncompressed: Array<{ ref: string; tokens: number }>
}

function fmt(n: number): string {
    const v = Math.max(0, Math.round(n))
    return v >= 1000 ? `~${(v / 1000).toFixed(1)}K` : `~${v}`
}

const LEDGER_ROWS = 8

/**
 * 紧急档恢复时把**预算和尺寸**给到模型。
 *
 * 260903 cc: 此前提示词说 "extends as far forward as is safely possible in one pass"，
 * 而模型手上只有 `mNNNN` 这种不透明 ID —— 让它按 token 量选范围，却不给它任何 token 量。
 * 结果就是猜，猜小了再被返回值纠正，每纠正一次是一个缓存重置点。
 *
 * 这里把决策需要的数放到决策**之前**：还差多少、从最老那条往后累计到哪个 ID 够。
 * 注在提醒里（一次注入）而不是给每条消息加尺寸标注 —— 后者每条消息都要付 token，
 * 而这张表只在真正要压的时候出现一次。
 */
export function buildRecoveryBudgetGuidance(budget: RecoveryBudget): string {
    const deficit = budget.currentTokens - budget.target
    if (deficit <= 0 || budget.uncompressed.length === 0) {
        return ""
    }

    const first = budget.uncompressed[0]!
    const rows: string[] = []
    let cumulative = 0
    let covered = false
    // 每隔 stride 取一个检查点，外加"第一个够本"的那一行必列
    const stride = Math.max(1, Math.ceil(budget.uncompressed.length / LEDGER_ROWS))
    for (let index = 0; index < budget.uncompressed.length; index++) {
        const entry = budget.uncompressed[index]!
        cumulative += entry.tokens
        const covers = !covered && cumulative >= deficit
        if (covers) {
            covered = true
        }
        const isCheckpoint = index % stride === stride - 1 || index === budget.uncompressed.length - 1
        if (!covers && !isCheckpoint) {
            continue
        }
        rows.push(
            `    ${first.ref}..${entry.ref} = ${fmt(cumulative)}${covers ? "   <- smallest range that covers the budget" : ""}`,
        )
    }

    return [
        "RECOVERY BUDGET",
        `- Context is ${fmt(budget.currentTokens)}; the recovery target is ${fmt(budget.target)}. You must remove at least ${fmt(deficit)} of history in ONE pass.`,
        `- Cumulative size of the oldest uncompressed history, starting at ${first.ref}:`,
        ...rows,
        `- Use ${first.ref} as startId. Pick the endId whose cumulative size covers the budget - stopping short means compressing again and paying another cache reset.`,
        "- These sizes exclude history already inside compressed blocks, so they are the real savings on offer.",
    ].join("\n")
}
