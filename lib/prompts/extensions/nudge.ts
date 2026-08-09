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
