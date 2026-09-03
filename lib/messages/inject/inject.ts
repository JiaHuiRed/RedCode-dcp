import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { RuntimePrompts } from "../../prompts/store"
import { formatMessageIdTag } from "../../message-ids"
import type { CompressionPriorityMap } from "../priority"
import { compressPermission } from "../../compress-permission"
import {
    getLastUserMessage,
    isIgnoredUserMessage,
    isProtectedUserMessage,
    messageHasCompress,
} from "../query"
import { saveSessionState } from "../../state/persistence"
import { sumCompressSavings } from "../../state/utils"
import {
    appendToTextPart,
    appendToLastTextPart,
    appendToAllToolParts,
    createSyntheticTextPart,
    hasContent,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudges,
    countMessagesAfterIndex,
    findLastNonIgnoredMessage,
    getAbsoluteNudgeFrequency,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimits,
    resolveRecoveryTarget,
    collectUncompressedLedger,
} from "./utils"
import { getCurrentTokenUsage } from "../../token-utils"

export const injectCompressNudges = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    prompts: RuntimePrompts,
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    if (state.manualMode) {
        return
    }

    const lastMessage = findLastNonIgnoredMessage(messages)
    const lastAssistantMessage = messages.findLast((message) => message.info.role === "assistant")

    const { providerId, modelId } = getModelInfo(messages)
    let anchorsChanged = false

    // 260831 cc: 刚压完这一轮，上报用量还是压缩生效前那次请求的数字（压缩要到下一次
    // 请求的 transform 才落地），判定前先扣掉本次 compress 的净收益，否则一次成功的
    // 大压缩会被误判成「还在线上」。
    const justCompressed = Boolean(lastAssistantMessage && messageHasCompress(lastAssistantMessage))
    const pendingSavings =
        justCompressed && lastAssistantMessage
            ? sumCompressSavings(state, lastAssistantMessage.info.id)
            : 0

    const { overMaxLimit, overMinLimit, currentTokens } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
        pendingSavings,
    )

    // 260903 cc: 紧急档一旦触发就进入「恢复中」，一路压到 min 才松手。
    //
    // 此前触发线与停止线同为 max：压到 max-1K 收手，再跑两轮又过线，于是一个会话反复压，
    // 每次都是缓存重置点。实测 ses_ffe5f9fca1 压了 9 次，其中 2 次净增（最小一次压 20
    // token、摘要 140 token）。min 与 max 之间那段是配置里留好的余量，恢复就该一次到位。
    const recoveryTarget = resolveRecoveryTarget(config, state, providerId, modelId)
    if (overMaxLimit) {
        state.nudges.recovering = true
    } else if (
        state.nudges.recovering &&
        (recoveryTarget === undefined || currentTokens <= recoveryTarget)
    ) {
        state.nudges.recovering = false
        anchorsChanged = true
    }
    const emergencyActive = overMaxLimit || state.nudges.recovering

    if (justCompressed) {
        // 非紧急三档照旧清空：刚压过就别连环催。
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        state.nudges.absoluteNudgeAnchors.clear()

        // 260831 cc: 紧急档不再无条件清。此前只要最后一条助手消息里有一次 completed 的
        // compress 就四档全清并 return——压掉 3K 也算数，那一轮之内再没有任何推力，
        // 模型压完最近一小块就收工（哥哥 08-30 在家实测：250K 压完仍是 250K）。
        state.nudges.contextLimitAnchors.clear()
        if (!emergencyActive) {
            void saveSessionState(state, logger)
            return
        }
        // 仍未回到目标线：锚点清掉是为了让下面的正常流程重新下在当前最后一条消息上——
        // 沿用旧锚会把提醒埋在历史中间，越靠后模型越读得到。
        anchorsChanged = true
    }

    if (!overMinLimit) {
        const hadTurnAnchors = state.nudges.turnNudgeAnchors.size > 0
        const hadIterationAnchors = state.nudges.iterationNudgeAnchors.size > 0

        if (hadTurnAnchors || hadIterationAnchors) {
            state.nudges.turnNudgeAnchors.clear()
            state.nudges.iterationNudgeAnchors.clear()
            anchorsChanged = true
        }
    }

    if (emergencyActive) {
        if (lastMessage) {
            const interval = getNudgeFrequency(config)
            const added = addAnchor(
                state.nudges.contextLimitAnchors,
                lastMessage.message.info.id,
                lastMessage.index,
                messages,
                interval,
            )
            if (added) {
                anchorsChanged = true
            }
        }
    } else if (overMinLimit) {
        // 260825 Red: absolute nudge 让位于 min 档，清掉残留锚防双 nudge 并存
        if (state.nudges.absoluteNudgeAnchors.size > 0) {
            state.nudges.absoluteNudgeAnchors.clear()
            anchorsChanged = true
        }

        const isLastMessageUser = lastMessage?.message.info.role === "user"

        if (isLastMessageUser && lastAssistantMessage) {
            // 260808 Red: turn nudge 同样走 nudgeFrequency 间隔，防止每条 user 消息都触发
            // 导致 nudge 高频注入 → 模型响应过度 → 微型压缩块
            const interval = getNudgeFrequency(config)
            const added = addAnchor(
                state.nudges.turnNudgeAnchors,
                lastMessage.message.info.id,
                lastMessage.index,
                messages,
                interval,
            )
            if (added) {
                state.nudges.turnNudgeAnchors.add(lastAssistantMessage.info.id)
                anchorsChanged = true
            }
        }

        const lastUserMessage = getLastUserMessage(messages)
        if (lastUserMessage && lastMessage) {
            const lastUserMessageIndex = messages.findIndex(
                (message) => message.info.id === lastUserMessage.info.id,
            )
            if (lastUserMessageIndex >= 0) {
                const messagesSinceUser = countMessagesAfterIndex(messages, lastUserMessageIndex)
                const iterationThreshold = getIterationNudgeThreshold(config)

                if (
                    lastMessage.index > lastUserMessageIndex &&
                    messagesSinceUser >= iterationThreshold
                ) {
                    const interval = getNudgeFrequency(config)
                    const added = addAnchor(
                        state.nudges.iterationNudgeAnchors,
                        lastMessage.message.info.id,
                        lastMessage.index,
                        messages,
                        interval,
                    )

                    if (added) {
                        anchorsChanged = true
                    }
                }
            }
        }
    }

    // 260825 Red: 收益档 nudge——绝对输入量已大但未到 min 档时，按 absoluteNudgeFrequency
    // 间隔周期性提醒。与 min/max 档独立；低于阈值时清残留锚。
    if (!emergencyActive && !overMinLimit) {
        const currentTokens = getCurrentTokenUsage(state, messages)

        if (currentTokens >= config.compress.absoluteNudgeThreshold && lastMessage) {
            const interval = getAbsoluteNudgeFrequency(config)
            const added = addAnchor(
                state.nudges.absoluteNudgeAnchors,
                lastMessage.message.info.id,
                lastMessage.index,
                messages,
                interval,
            )
            if (added) {
                anchorsChanged = true
            }
        } else if (state.nudges.absoluteNudgeAnchors.size > 0) {
            state.nudges.absoluteNudgeAnchors.clear()
            anchorsChanged = true
        }
    }

    // 260903 cc: 恢复期间把预算表算出来交给紧急档提醒 —— 让模型在**选范围之前**
    // 就知道还差多少、累计到哪个 ID 够。此前它只有不透明的 mNNNN，只能猜。
    const recoveryBudget =
        emergencyActive && recoveryTarget !== undefined && currentTokens > recoveryTarget
            ? {
                  currentTokens,
                  target: recoveryTarget,
                  uncompressed: collectUncompressedLedger(state, messages),
              }
            : undefined

    applyAnchoredNudges(state, config, messages, prompts, compressionPriorities, recoveryBudget)

    if (anchorsChanged) {
        void saveSessionState(state, logger)
    }
}

export const injectMessageIds = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    compressionPriorities?: CompressionPriorityMap,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    for (const message of messages) {
        if (isIgnoredUserMessage(message)) {
            continue
        }

        const messageRef = state.messageIds.byRawId.get(message.info.id)
        if (!messageRef) {
            continue
        }

        const isBlockedMessage = isProtectedUserMessage(config, message)
        const priority =
            config.compress.mode === "message" && !isBlockedMessage
                ? compressionPriorities?.get(message.info.id)?.priority
                : undefined
        const tag = formatMessageIdTag(
            isBlockedMessage ? "BLOCKED" : messageRef,
            priority ? { priority } : undefined,
        )

        if (message.info.role === "user") {
            let injected = false
            for (const part of message.parts) {
                if (part.type === "text") {
                    injected = appendToTextPart(part, tag) || injected
                }
            }

            if (injected) {
                continue
            }

            message.parts.push(createSyntheticTextPart(message, tag))
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        if (!hasContent(message)) {
            continue
        }

        if (appendToAllToolParts(message, tag)) {
            continue
        }

        if (appendToLastTextPart(message, tag)) {
            continue
        }

        const syntheticPart = createSyntheticTextPart(message, tag)
        const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
        if (firstToolIndex === -1) {
            message.parts.push(syntheticPart)
        } else {
            message.parts.splice(firstToolIndex, 0, syntheticPart)
        }
    }
}
