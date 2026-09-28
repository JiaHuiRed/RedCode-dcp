import type { SessionState, WithParts, WorkingState, WorkingStateFailedCall } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import type { SelectionResolution } from "./types"

// 260928 Red workingState 注入随压缩块 summary 走（模型可见），必须有硬上限。
// 超预算时按 userPrompts → filesTouched → failedCalls 的顺序丢弃：
// 错误现场最难重建，failedCalls 保存到最后。
const WORKING_STATE_BUDGET_CHARS = 1024
const MAX_FILES_TOUCHED = 20
const MAX_FAILED_CALLS = 10
const MAX_USER_PROMPTS = 5
const MAX_PROMPT_CHARS = 120
const MAX_ERROR_CHARS = 200
const MAX_INPUT_CHARS = 120

// 只有参数里带目标文件路径的工具才算「动过文件」。read/grep 是读不进；
// bash 参数是命令行，从中抽路径太启发式，不可靠的提取比没有更糟。
const FILE_MUTATING_TOOLS = new Set(["edit", "write", "multiedit", "patch"])

const extractFilePath = (parameters: unknown): string | undefined => {
    if (!parameters || typeof parameters !== "object") {
        return undefined
    }
    const record = parameters as Record<string, unknown>
    for (const key of ["filePath", "file_path", "path"]) {
        const value = record[key]
        if (typeof value === "string" && value.length > 0) {
            return value
        }
    }
    return undefined
}

const firstLine = (text: string, maxChars: number): string => {
    const line = text.split("\n", 1)[0] ?? text
    return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

export const workingStateSize = (workingState: WorkingState): number =>
    JSON.stringify(workingState).length

const isEmpty = (workingState: WorkingState): boolean =>
    workingState.filesTouched.length === 0 &&
    workingState.failedCalls.length === 0 &&
    workingState.userPrompts.length === 0

/**
 * 从 selection 覆盖的工具调用与消息里机械提取工作状态。
 * 只覆盖本次压缩范围（selection），不扫全会话——块的状态跟块内容精确对应，
 * decompress 某块时看到的就是那一段的文件清单与失败调用。
 */
export function buildWorkingState(
    state: SessionState,
    selection: SelectionResolution,
    rawMessages: WithParts[],
): WorkingState | undefined {
    const filesTouched: string[] = []
    const failedCalls: WorkingStateFailedCall[] = []

    for (const callId of selection.toolIds) {
        const entry = state.toolParameters.get(callId)
        if (!entry) {
            continue
        }

        if (FILE_MUTATING_TOOLS.has(entry.tool.toLowerCase()) && filesTouched.length < MAX_FILES_TOUCHED) {
            const filePath = extractFilePath(entry.parameters)
            if (filePath && !filesTouched.includes(filePath)) {
                filesTouched.push(filePath)
            }
        }

        if (entry.status === "error" && failedCalls.length < MAX_FAILED_CALLS) {
            failedCalls.push({
                tool: entry.tool,
                input: firstLine(
                    typeof entry.parameters === "string"
                        ? entry.parameters
                        : JSON.stringify(entry.parameters ?? {}),
                    MAX_INPUT_CHARS,
                ),
                error: firstLine(entry.error ?? "unknown error", MAX_ERROR_CHARS),
            })
        }
    }

    const messageIds = new Set(selection.messageIds)
    const userPrompts: string[] = []
    for (const msg of rawMessages) {
        if (!messageIds.has(msg.info.id)) {
            continue
        }
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }
        const text = msg.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text?: string }).text ?? "")
            .join(" ")
            .trim()
        if (text.length === 0) {
            continue
        }
        userPrompts.push(firstLine(text, MAX_PROMPT_CHARS))
        if (userPrompts.length >= MAX_USER_PROMPTS) {
            break
        }
    }

    const workingState: WorkingState = { filesTouched, failedCalls, userPrompts }
    if (isEmpty(workingState)) {
        return undefined
    }

    while (workingStateSize(workingState) > WORKING_STATE_BUDGET_CHARS) {
        if (workingState.userPrompts.length > 0) {
            workingState.userPrompts.pop()
        } else if (workingState.filesTouched.length > 0) {
            workingState.filesTouched.pop()
        } else if (workingState.failedCalls.length > 0) {
            workingState.failedCalls.pop()
        } else {
            break
        }
    }
    if (isEmpty(workingState)) {
        return undefined
    }
    return workingState
}

/** 渲染为随 summary 注入的文本段（英文，与 nudge 模板同语言）。 */
export function formatWorkingState(workingState: WorkingState): string {
    const lines: string[] = ["Working state (mechanically extracted):"]
    if (workingState.filesTouched.length > 0) {
        lines.push(`Files touched: ${workingState.filesTouched.join(", ")}`)
    }
    for (const call of workingState.failedCalls) {
        lines.push(`Failed: ${call.tool} — ${call.error} (input: ${call.input})`)
    }
    if (workingState.userPrompts.length > 0) {
        lines.push("User prompts in this range:")
        for (const prompt of workingState.userPrompts) {
            lines.push(`- ${prompt}`)
        }
    }
    return lines.join("\n")
}

/** 持久化恢复：逐字段显式校验，空快照还原成 undefined（与写入侧对称）。 */
export function parseWorkingState(value: unknown): WorkingState | undefined {
    if (!value || typeof value !== "object") {
        return undefined
    }
    const record = value as Record<string, unknown>
    const filesTouched = Array.isArray(record.filesTouched)
        ? record.filesTouched.filter((item): item is string => typeof item === "string")
        : []
    const failedCalls = Array.isArray(record.failedCalls)
        ? record.failedCalls.flatMap((item): WorkingStateFailedCall[] => {
              if (!item || typeof item !== "object") {
                  return []
              }
              const call = item as Record<string, unknown>
              if (typeof call.tool !== "string") {
                  return []
              }
              return [
                  {
                      tool: call.tool,
                      input: typeof call.input === "string" ? call.input : "",
                      error: typeof call.error === "string" ? call.error : "",
                  },
              ]
          })
        : []
    const userPrompts = Array.isArray(record.userPrompts)
        ? record.userPrompts.filter((item): item is string => typeof item === "string")
        : []
    const workingState: WorkingState = { filesTouched, failedCalls, userPrompts }
    if (isEmpty(workingState)) {
        return undefined
    }
    return workingState
}
