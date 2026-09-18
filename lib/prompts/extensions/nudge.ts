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
const RECOVERY_SUMMARY_FLOOR = 12_000
const RECOVERY_SUMMARY_SHARE = 0.1

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

    // 260918 Red 摘要成本更接近「交接固定量 + 小比例」而非纯范围比例：本会话两次实测
    // 60.5K→8.7K、148.3K→12.0K。下限保护小范围，比例避免大范围白压历史；
    // 工具端仍按实际摘要 token 硬验，模型写得过长时不会静默放行。
    const summaryBudget = Math.max(
        RECOVERY_SUMMARY_FLOOR,
        Math.ceil(deficit * RECOVERY_SUMMARY_SHARE),
    )
    const selectionTarget = deficit + summaryBudget
    // 260914 Red: 缺口大于全部剩余可压内容时，「选一个覆盖目标的 endId」是物理上不存在的
    // 指令——实测缺口 124.9K 而可压总量只有 3.8K，模型拿到自相矛盾的预算表只能反复试错。
    // 封顶档改用覆盖率语义：一把压满全部剩余历史即算完成（工具端按覆盖率 ≥95% 放行，
    // 见 viability.checkRecoveryBudget）。
    const available = budget.uncompressed.reduce((total, entry) => total + entry.tokens, 0)
    if (available <= 0) {
        return ""
    }
    const capped = selectionTarget > available
    const first = budget.uncompressed[0]!
    const last = budget.uncompressed[budget.uncompressed.length - 1]!
    const rows: string[] = []
    let cumulative = 0
    let covered = false
    // 每隔 stride 取一个检查点，外加"第一个够本"的那一行必列
    const stride = Math.max(1, Math.ceil(budget.uncompressed.length / LEDGER_ROWS))
    for (let index = 0; index < budget.uncompressed.length; index++) {
        const entry = budget.uncompressed[index]!
        cumulative += entry.tokens
        const covers = !capped && !covered && cumulative >= selectionTarget
        if (covers) {
            covered = true
        }
        const isLast = index === budget.uncompressed.length - 1
        const isCheckpoint = index % stride === stride - 1 || isLast
        if (!covers && !isCheckpoint) {
            continue
        }
        const mark = covers
            ? "   <- smallest range that covers the budget"
            : capped && isLast
              ? "   <- all remaining compressible history"
              : ""
        rows.push(`    ${first.ref}..${entry.ref} = ${fmt(cumulative)}${mark}`)
    }

    if (capped) {
        return [
            "RECOVERY BUDGET",
            `- Context is ${fmt(budget.currentTokens)}; the recovery target is ${fmt(budget.target)} (deficit ${fmt(deficit)}). The remaining compressible history totals only ${fmt(available)} — the rest of the context is system prompt, tool schemas, protected content and existing blocks, which compression cannot shrink.`,
            `- Cumulative size of the oldest uncompressed history, starting at ${first.ref}:`,
            ...rows,
            `- Use ${first.ref} as startId and ${last.ref} as endId to compress the WHOLE remaining history in one pass. That is the maximum possible; a full-coverage pass counts as complete even though it cannot close the whole deficit.`,
            "- These sizes exclude history already inside compressed blocks, so they are the real savings on offer.",
        ].join("\n")
    }

    return [
        "RECOVERY BUDGET",
        `- Context is ${fmt(budget.currentTokens)}; the recovery target is ${fmt(budget.target)}. You must net at least ${fmt(deficit)} in ONE pass, so select about ${fmt(selectionTarget)} of raw history and keep your summary under ${fmt(summaryBudget)}.`,
        "- If your summary needs more than that budget, extend the range past the marked row - the tool validates against the real summary size.",
        `- Cumulative size of the oldest uncompressed history, starting at ${first.ref}:`,
        ...rows,
        `- Use ${first.ref} as startId. Pick the endId whose cumulative size covers the marked target. A smaller recovery batch is rejected before it resets the prefix cache.`,
        "- These sizes exclude history already inside compressed blocks, so they are the real savings on offer.",
    ].join("\n")
}
