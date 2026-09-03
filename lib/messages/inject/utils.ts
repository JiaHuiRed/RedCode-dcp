import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import {
    appendGuidanceToDcpTag,
    buildCompressedBlockGuidance,
    buildRecoveryBudgetGuidance,
    type RecoveryBudget,
    renderMessagePriorityGuidance,
} from "../../prompts/extensions/nudge"
import type { RuntimePrompts } from "../../prompts/store"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
    type CompressionPriorityMap,
    type MessagePriority,
    listPriorityRefsBeforeIndex,
} from "../priority"
import {
    appendToTextPart,
    appendToLastTextPart,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import { getLastUserMessage, isIgnoredUserMessage } from "../query"
import { countAllMessageTokens, getCurrentTokenUsage } from "../../token-utils"
import { getActiveSummaryTokenUsage } from "../../state/utils"

const MESSAGE_MODE_NUDGE_PRIORITY: MessagePriority = "high"

export interface LastUserModelContext {
    providerId: string | undefined
    modelId: string | undefined
}

export interface LastNonIgnoredMessage {
    message: WithParts
    index: number
}

export function getNudgeFrequency(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1))
}

export function getAbsoluteNudgeFrequency(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.absoluteNudgeFrequency || 1))
}

export function getIterationNudgeThreshold(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))
}

export function findLastNonIgnoredMessage(messages: WithParts[]): LastNonIgnoredMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        return { message, index: i }
    }

    return null
}

export function countMessagesAfterIndex(messages: WithParts[], index: number): number {
    let count = 0

    for (let i = index + 1; i < messages.length; i++) {
        const message = messages[i]
        if (isIgnoredUserMessage(message)) {
            continue
        }
        count++
    }

    return count
}

export function getModelInfo(messages: WithParts[]): LastUserModelContext {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return {
            providerId: undefined,
            modelId: undefined,
        }
    }

    const userInfo = lastUserMessage.info as UserMessage
    return {
        providerId: userInfo.model.providerID,
        modelId: userInfo.model.modelID,
    }
}

// 260831 cc: 每模型触发线的查表键是 `${providerID}/${modelID}`，写错 provider 会静默回落到
// 全局默认值——2026-08-11 实测这就是「新 DCP 却像旧行为」的成因，当时全程没有任何日志。
// 只在用户确实配了每模型触发线却没命中时报，同一个键每进程报一次。
const warnedModelLimitKeys = new Set<string>()

export interface ModelLimitMiss {
    key: string
    // 只报「配了但没命中」的那一档；另一档没配就是本来就打算走全局值。
    thresholds: Array<"max" | "min">
    // 已配置的键里 modelID 相同、provider 不同的那些——写错 provider 时这就是直接答案。
    sameModelKeys: string[]
}

export function detectModelLimitMiss(
    config: PluginConfig,
    providerId: string | undefined,
    modelId: string | undefined,
): ModelLimitMiss | undefined {
    if (providerId === undefined || modelId === undefined) {
        return undefined
    }

    const tables: Array<{
        threshold: "max" | "min"
        limits: Record<string, number | `${number}%`> | undefined
    }> = [
        { threshold: "max", limits: config.compress.modelMaxLimits },
        { threshold: "min", limits: config.compress.modelMinLimits },
    ]

    const key = `${providerId}/${modelId}`
    const thresholds: Array<"max" | "min"> = []
    const sameModelKeys = new Set<string>()

    for (const { threshold, limits } of tables) {
        if (!limits) continue
        const configuredKeys = Object.keys(limits)
        if (configuredKeys.length === 0) continue
        if (limits[key] !== undefined) continue

        thresholds.push(threshold)
        for (const configured of configuredKeys) {
            if (configured.slice(configured.indexOf("/") + 1) === modelId) {
                sameModelKeys.add(configured)
            }
        }
    }

    if (thresholds.length === 0) {
        return undefined
    }

    if (warnedModelLimitKeys.has(key)) {
        return undefined
    }
    warnedModelLimitKeys.add(key)

    return { key, thresholds, sameModelKeys: [...sameModelKeys].sort() }
}

export async function reportModelLimitMiss(
    client: any,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): Promise<void> {
    const { providerId, modelId } = getModelInfo(messages)
    const miss = detectModelLimitMiss(config, providerId, modelId)
    if (!miss) {
        return
    }

    const tables = miss.thresholds.map((t) => (t === "max" ? "modelMaxLimits" : "modelMinLimits"))
    const lines = [`${miss.key} 未配置 ${tables.join(" / ")}，已回落到全局触发线。`]
    if (miss.sameModelKeys.length > 0) {
        lines.push(`同名模型已配置的键：${miss.sameModelKeys.join(", ")}`)
    }

    logger.warn("Model context limit key missed", {
        key: miss.key,
        thresholds: miss.thresholds,
        sameModelKeys: miss.sameModelKeys,
    })

    try {
        await client.tui.showToast({
            body: {
                title: "DCP: 每模型触发线未命中",
                message: lines.join("\n"),
                variant: "warning",
                duration: 8000,
            },
        })
    } catch {}
}

function resolveContextTokenLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    threshold: "max" | "min",
): number | undefined {
    const parseLimitValue = (limit: number | `${number}%` | undefined): number | undefined => {
        if (limit === undefined) {
            return undefined
        }

        if (typeof limit === "number") {
            return limit
        }

        if (!limit.endsWith("%") || state.modelContextLimit === undefined) {
            return undefined
        }

        const parsedPercent = parseFloat(limit.slice(0, -1))
        if (isNaN(parsedPercent)) {
            return undefined
        }

        const roundedPercent = Math.round(parsedPercent)
        const clampedPercent = Math.max(0, Math.min(100, roundedPercent))
        return Math.round((clampedPercent / 100) * state.modelContextLimit)
    }

    const modelLimits =
        threshold === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits
    if (modelLimits && providerId !== undefined && modelId !== undefined) {
        const providerModelId = `${providerId}/${modelId}`
        const modelLimit = modelLimits[providerModelId]
        if (modelLimit !== undefined) {
            return parseLimitValue(modelLimit)
        }
    }

    const globalLimit =
        threshold === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit
    return parseLimitValue(globalLimit)
}

export function resolveContextLimits(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
): { min: number | undefined; max: number | undefined } {
    return {
        min: resolveContextTokenLimit(config, state, providerId, modelId, "min"),
        max: resolveContextTokenLimit(config, state, providerId, modelId, "max"),
    }
}

export function isContextOverLimits(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    messages: WithParts[],
    // 260831 cc: 已发生但尚未反映在上报用量里的收益（刚跑完的那次 compress），判定前先扣掉。
    pendingSavings: number = 0,
) {
    const summaryTokenExtension = config.compress.summaryBuffer
        ? getActiveSummaryTokenUsage(state)
        : 0
    const resolvedMaxContextLimit = resolveContextTokenLimit(
        config,
        state,
        providerId,
        modelId,
        "max",
    )
    const maxContextLimit =
        resolvedMaxContextLimit === undefined
            ? undefined
            : resolvedMaxContextLimit + summaryTokenExtension
    const minContextLimit = resolveContextTokenLimit(config, state, providerId, modelId, "min")
    const currentTokens = Math.max(0, getCurrentTokenUsage(state, messages) - pendingSavings)

    const overMaxLimit = maxContextLimit === undefined ? false : currentTokens > maxContextLimit
    const overMinLimit = minContextLimit === undefined ? true : currentTokens >= minContextLimit

    return {
        overMaxLimit,
        overMinLimit,
        currentTokens,
        minContextLimit,
        maxContextLimit,
    }
}

/**
 * 紧急档恢复的目标线。
 *
 * 260903 cc: 触发用 max、收手也用 max，等于压到线上就停，两轮之后又过线。min 与 max
 * 之间那段（本仓配置 150K vs 220K，差 70K）本来就是留出来的余量，恢复就该一次压到那儿。
 * 没配 min 时退回 max（此时行为与改动前一致）。
 */
export function resolveRecoveryTarget(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
): number | undefined {
    const { min, max } = resolveContextLimits(config, state, providerId, modelId)
    return min ?? max
}

export function addAnchor(
    anchorMessageIds: Set<string>,
    anchorMessageId: string,
    anchorMessageIndex: number,
    messages: WithParts[],
    interval: number,
): boolean {
    if (anchorMessageIndex < 0) {
        return false
    }

    let latestAnchorMessageIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (anchorMessageIds.has(messages[i].info.id)) {
            latestAnchorMessageIndex = i
            break
        }
    }

    const shouldAdd =
        latestAnchorMessageIndex < 0 || anchorMessageIndex - latestAnchorMessageIndex >= interval
    if (!shouldAdd) {
        return false
    }

    const previousSize = anchorMessageIds.size
    anchorMessageIds.add(anchorMessageId)
    return anchorMessageIds.size !== previousSize
}

function buildMessagePriorityGuidance(
    messages: WithParts[],
    compressionPriorities: CompressionPriorityMap | undefined,
    anchorIndex: number,
    priority: MessagePriority,
): string {
    if (!compressionPriorities || compressionPriorities.size === 0) {
        return ""
    }

    const refs = listPriorityRefsBeforeIndex(messages, compressionPriorities, anchorIndex, priority)
    const priorityLabel = `${priority[0].toUpperCase()}${priority.slice(1)}`

    return renderMessagePriorityGuidance(priorityLabel, refs)
}

function injectAnchoredNudge(message: WithParts, nudgeText: string): void {
    if (!nudgeText.trim()) {
        return
    }

    if (message.info.role === "user") {
        if (appendToLastTextPart(message, nudgeText)) {
            return
        }

        message.parts.push(createSyntheticTextPart(message, nudgeText))
        return
    }

    if (message.info.role !== "assistant") {
        return
    }

    if (!hasContent(message)) {
        return
    }

    for (const part of message.parts) {
        if (part.type === "text") {
            if (appendToTextPart(part, nudgeText)) {
                return
            }
        }
    }

    const syntheticPart = createSyntheticTextPart(message, nudgeText)
    const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
    if (firstToolIndex === -1) {
        message.parts.push(syntheticPart)
    } else {
        message.parts.splice(firstToolIndex, 0, syntheticPart)
    }
}

function collectAnchoredMessages(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
): Array<{ message: WithParts; index: number }> {
    const anchoredMessages: Array<{ message: WithParts; index: number }> = []

    for (const anchorMessageId of anchorMessageIds) {
        const index = messages.findIndex((message) => message.info.id === anchorMessageId)
        if (index === -1) {
            continue
        }

        anchoredMessages.push({
            message: messages[index],
            index,
        })
    }

    return anchoredMessages
}

function collectTurnNudgeAnchors(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): Set<string> {
    const turnNudgeAnchors = new Set<string>()
    const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant"

    for (const message of messages) {
        if (!state.nudges.turnNudgeAnchors.has(message.info.id)) continue

        if (message.info.role === targetRole) {
            turnNudgeAnchors.add(message.info.id)
        }
    }

    return turnNudgeAnchors
}

function applyRangeModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
    compressedBlockGuidance: string,
    budgetGuidance?: string,
): void {
    if (!baseNudgeText) {
        return
    }
    const nudgeText = appendGuidanceToDcpTag(baseNudgeText, compressedBlockGuidance)
    if (!nudgeText.trim()) {
        return
    }

    // 260903 cc: 预算表**只挂最后一个锚**。
    //
    // 里面的当前用量每轮都在变，而锚是会累积的（每 nudgeFrequency 条加一个）。若每个锚
    // 都带这段动态文本，最老那个锚往后的前缀每轮都要作废 —— 那就是在修缓存问题的同时
    // 制造一个新的缓存问题。最后一个锚在上下文末尾，改它只作废尾巴。
    // 按会话位置排，不是 Set 的插入顺序 ——「最后一个锚」指上下文里最靠后的那条。
    const anchored = [...collectAnchoredMessages(anchorMessageIds, messages)].sort(
        (left, right) => left.index - right.index,
    )
    const newest = anchored.at(-1)
    for (const entry of anchored) {
        const text =
            entry === newest && budgetGuidance
                ? appendGuidanceToDcpTag(
                      baseNudgeText,
                      `${budgetGuidance}\n\n${compressedBlockGuidance}`,
                  )
                : nudgeText
        injectAnchoredNudge(entry.message, text)
    }
}

function applyMessageModeAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    baseNudgeText: string,
    compressionPriorities?: CompressionPriorityMap,
    budgetGuidance?: string,
): void {
    if (!baseNudgeText) {
        return
    }
    // 预算表只挂最新的那个锚，理由见 applyRangeModeAnchoredNudge 里的注释。
    const anchored = [...collectAnchoredMessages(anchorMessageIds, messages)].sort(
        (left, right) => left.index - right.index,
    )
    const newest = anchored.at(-1)
    for (const entry of anchored) {
        const priorityGuidance = buildMessagePriorityGuidance(
            messages,
            compressionPriorities,
            entry.index,
            MESSAGE_MODE_NUDGE_PRIORITY,
        )
        const guidance =
            entry === newest && budgetGuidance
                ? `${budgetGuidance}\n\n${priorityGuidance}`
                : priorityGuidance
        const nudgeText = appendGuidanceToDcpTag(baseNudgeText, guidance)
        injectAnchoredNudge(entry.message, nudgeText)
    }
}

/**
 * 最老的未压缩历史清单，供恢复预算表使用。
 *
 * 260903 cc: 跳过已经在活跃块里的消息 —— 再压一遍不产生任何新收益，
 * 口径与 applyCompressionState 的 compressedTokens 一致。
 */
export function collectUncompressedLedger(
    state: SessionState,
    messages: WithParts[],
): RecoveryBudget["uncompressed"] {
    const ledger: RecoveryBudget["uncompressed"] = []
    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }
        const ref = state.messageIds.byRawId.get(message.info.id)
        if (!ref) {
            continue
        }
        const entry = state.prune.messages.byMessageId.get(message.info.id)
        if (entry && entry.activeBlockIds.length > 0) {
            continue
        }
        ledger.push({ ref, tokens: entry?.tokenCount ?? countAllMessageTokens(message) })
    }
    return ledger
}

export function applyAnchoredNudges(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
    recoveryBudget?: RecoveryBudget,
): void {
    const turnNudgeAnchors = collectTurnNudgeAnchors(state, config, messages)
    // 260903 cc: 预算表只挂紧急档。收益档的设计是"只压已闭合的段"，给它一个"必须删 N"
    //   的硬指标会把它变成第二个紧急档。
    const budgetGuidance = recoveryBudget ? buildRecoveryBudgetGuidance(recoveryBudget) : ""

    if (config.compress.mode === "message") {
        applyMessageModeAnchoredNudge(
            state.nudges.contextLimitAnchors,
            messages,
            prompts.contextLimitNudge,
            compressionPriorities,
            budgetGuidance,
        )
        applyMessageModeAnchoredNudge(
            turnNudgeAnchors,
            messages,
            prompts.turnNudge,
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            state.nudges.iterationNudgeAnchors,
            messages,
            prompts.iterationNudge,
            compressionPriorities,
        )
        applyMessageModeAnchoredNudge(
            state.nudges.absoluteNudgeAnchors,
            messages,
            prompts.absoluteNudge,
            compressionPriorities,
        )
        return
    }

    const compressedBlockGuidance = buildCompressedBlockGuidance(state)
    applyRangeModeAnchoredNudge(
        state.nudges.contextLimitAnchors,
        messages,
        prompts.contextLimitNudge,
        compressedBlockGuidance,
        budgetGuidance,
    )
    applyRangeModeAnchoredNudge(
        turnNudgeAnchors,
        messages,
        prompts.turnNudge,
        compressedBlockGuidance,
    )
    applyRangeModeAnchoredNudge(
        state.nudges.iterationNudgeAnchors,
        messages,
        prompts.iterationNudge,
        compressedBlockGuidance,
    )
    applyRangeModeAnchoredNudge(
        state.nudges.absoluteNudgeAnchors,
        messages,
        prompts.absoluteNudge,
        compressedBlockGuidance,
    )
}
