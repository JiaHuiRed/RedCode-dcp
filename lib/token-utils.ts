import { SessionState, WithParts } from "./state"
import { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Logger } from "./logger"
import * as _anthropicTokenizer from "@anthropic-ai/tokenizer"
const anthropicCountTokens = (_anthropicTokenizer.countTokens ??
    (_anthropicTokenizer as any).default?.countTokens) as typeof _anthropicTokenizer.countTokens
import { getLastUserMessage } from "./messages/query"

export function getCurrentTokenUsage(state: SessionState, messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") {
            continue
        }

        const assistantInfo = msg.info as AssistantMessage
        // 260818 Red: 纯 reasoning 轮（output=0 但 reasoning>0，deepseek-v4 系列典型）
        // 必须参与用量估算——只看 output 会把这类轮次跳过、回退到更早消息，
        // 低估当前上下文、延迟压缩触发（压缩后首条纯思考轮甚至误报 0）。
        if ((assistantInfo.tokens?.output || 0) + (assistantInfo.tokens?.reasoning || 0) <= 0) {
            continue
        }

        if (
            state.lastCompaction > 0 &&
            (msg.info.time.created < state.lastCompaction ||
                (msg.info.summary === true && msg.info.time.created === state.lastCompaction))
        ) {
            return 0
        }

        const input = assistantInfo.tokens?.input || 0
        const output = assistantInfo.tokens?.output || 0
        const reasoning = assistantInfo.tokens?.reasoning || 0
        const cacheRead = assistantInfo.tokens?.cache?.read || 0
        const cacheWrite = assistantInfo.tokens?.cache?.write || 0
        return input + output + reasoning + cacheRead + cacheWrite
    }

    return 0
}

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: undefined,
        }
    }
    const userInfo = userMsg.info as UserMessage
    const agent: string = userInfo.agent
    const providerId: string | undefined = userInfo.model.providerID
    const modelId: string | undefined = userInfo.model.modelID
    const variant: string | undefined = userInfo.model.variant

    return { providerId, modelId, agent, variant }
}

export function countTokens(text: string): number {
    if (!text) return 0
    try {
        return anthropicCountTokens(text)
    } catch {
        return Math.round(text.length / 4)
    }
}

export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "))
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

function stringifyToolContent(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value)
}

export function extractCompletedToolOutput(part: any): string | undefined {
    if (
        part?.type !== "tool" ||
        part.state?.status !== "completed" ||
        part.state?.output === undefined
    ) {
        return undefined
    }

    if (part.state?.time?.compacted) {
        return COMPACTED_TOOL_OUTPUT_PLACEHOLDER
    }

    return stringifyToolContent(part.state.output)
}

export function extractToolContent(part: any): string[] {
    const contents: string[] = []

    if (part?.type !== "tool") {
        return contents
    }

    if (part.state?.input !== undefined) {
        contents.push(stringifyToolContent(part.state.input))
    }

    const completedOutput = extractCompletedToolOutput(part)
    if (completedOutput !== undefined) {
        contents.push(completedOutput)
    } else if (part.state?.status === "error" && part.state?.error) {
        contents.push(stringifyToolContent(part.state.error))
    }

    return contents
}

export function countToolTokens(part: any): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

export function countMessageTextTokens(msg: WithParts): number {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export function countAllMessageTokens(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        } else if (part.type !== "reasoning") {
            texts.push(...extractToolContent(part))
        }
    }
    const base = texts.length === 0 ? 0 : estimateTokensBatch(texts)
    // 260916 Red: reasoning 必须计入 —— RedCode 会把它原样回传进下一轮提示词。
    //   实测（本会话 70 轮，残差 = context 增量 - output - 工具输出估算）：残差逐轮等于
    //   tokens.reasoning，如 reas=5763/resid=5762、reas=9613/resid=9661。本函数此前只算
    //   text + tool，整块漏掉 reasoning：一次 59 条消息的压缩真实净省 111.9K、估算只给
    //   84.6K（漏 59.8K reasoning）。后果是 selection/available 系统性偏低，
    //   checkRecoveryBudget 拿低估的 selection 对真实的 required（来自 provider 报数），
    //   本该放行的批次被反复拒绝。
    //   reasoning 优先用 provider 报数：tokens.reasoning 就是这段文本在真实 tokenizer 下
    //   的值；anthropic tokenizer 对它高估约 25%（实测 125.4K vs 100.4K）。无报数
    //   （流式中、或历史消息缺 usage）时退回文本估算。
    const reportedReasoning = (msg.info as AssistantMessage | undefined)?.tokens?.reasoning ?? 0
    if (reportedReasoning > 0) {
        return base + reportedReasoning
    }

    let reasoningText = ""
    for (const part of parts) {
        if (part.type === "reasoning" && part.text) {
            reasoningText = reasoningText ? `${reasoningText} ${part.text}` : part.text
        }
    }
    return reasoningText ? base + countTokens(reasoningText) : base
}
