import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveRanges,
    validateArgs,
    validateNonOverlapping,
    validateSummaryPlaceholders,
} from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressRangeToolArgs } from "./types"
import { formatCompressionOutcome } from "./outcome"
import {
    checkRecoveryBudget,
    checkViability,
    estimateNewlyCompressedTokens,
    formatViabilityRejection,
    type ViabilityFailure,
} from "./viability"
import { getModelInfo, resolveRecoveryTarget } from "../messages/inject/utils"
import { getCurrentTokenUsage } from "../token-utils"

function buildSchema(runtimePrompts: string) {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            "Message or block ID marking the beginning of range (e.g. m0001, b2)",
                        ),
                    endId: tool.schema
                        .string()
                        .describe("Message or block ID marking the end of range (e.g. m0012, b5)"),
                    summary: tool.schema.string().describe(runtimePrompts),
                }),
            )
            .describe(
                "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

// 260808 Red: description 保持精简，完整指令下沉到 summary 字段 describe，
// 避免模型把长指令复述进正文（instruction-echo 剥离的泄漏源）
const RANGE_DESCRIPTION =
    "Collapse a range of conversation messages into a detailed summary. " +
    "Provide startId/endId from the injected mNNNN or bN IDs; read the summary field instructions."

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: RANGE_DESCRIPTION,
        args: buildSchema(runtimePrompts.compressRange),
        async execute(args, toolCtx) {
            const input = args as CompressRangeToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Range: ${input.topic}`,
            )
            const resolvedPlans = resolveRanges(input, searchContext, ctx.state)
            validateNonOverlapping(resolvedPlans)

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                entry: (typeof resolvedPlans)[number]["entry"]
                selection: (typeof resolvedPlans)[number]["selection"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
            }> = []
            let totalCompressedMessages = 0

            for (const plan of resolvedPlans) {
                const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary)
                const missingBlockIds = validateSummaryPlaceholders(
                    parsedPlaceholders,
                    plan.selection.requiredBlockIds,
                    plan.selection.startReference,
                    plan.selection.endReference,
                    searchContext.summaryByBlockId,
                )

                const injected = injectBlockPlaceholders(
                    plan.entry.summary,
                    parsedPlaceholders,
                    searchContext.summaryByBlockId,
                    plan.selection.startReference,
                    plan.selection.endReference,
                )

                const summaryWithUsers = appendProtectedUserMessages(
                    injected.expandedSummary,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectUserMessages,
                )

                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    summaryWithUsers,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectTags,
                )

                const summaryWithTools = await appendProtectedTools(
                    ctx.client,
                    ctx.state,
                    ctx.config.experimental.allowSubAgents,
                    summaryWithPromptInfo,
                    plan.selection,
                    searchContext,
                    ctx.config.compress.protectedTools,
                    ctx.config.protectedFilePatterns,
                )

                const completedSummary = appendMissingBlockSummaries(
                    summaryWithTools,
                    missingBlockIds,
                    searchContext.summaryByBlockId,
                    injected.consumedBlockIds,
                )

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary: completedSummary.expandedSummary,
                    consumedBlockIds: completedSummary.consumedBlockIds,
                })
            }

            // 260903 cc: 还不起本钱的压缩在落库前拦掉，理由见 viability.ts。
            // 放在这里而不是 resolveRanges 里：要等摘要拼完（含协议内容/用户消息回填）
            // 才知道真实的摘要体积，而"摘要比它替换的还大"正是实际发生过的那一种。
            const viabilityFailures: ViabilityFailure[] = []
            const firstBlockId = ctx.state.prune.messages.nextBlockId
            const storedSummaryTokens = preparedPlans.map((preparedPlan, index) =>
                countTokens(
                    wrapCompressedSummary(
                        Number.isInteger(firstBlockId) && firstBlockId > 0
                            ? firstBlockId + index
                            : index + 1,
                        preparedPlan.finalSummary,
                    ),
                ),
            )
            for (const [index, preparedPlan] of preparedPlans.entries()) {
                const failure = checkViability(
                    ctx.state,
                    preparedPlan.entry.startId,
                    preparedPlan.entry.endId,
                    preparedPlan.selection,
                    preparedPlan.finalSummary,
                    { summaryTokens: storedSummaryTokens[index]! },
                )
                if (failure) {
                    viabilityFailures.push(failure)
                }
            }
            if (viabilityFailures.length === 0 && preparedPlans.length > 0) {
                const { providerId, modelId } = getModelInfo(rawMessages)
                const recoveryTarget = resolveRecoveryTarget(
                    ctx.config,
                    ctx.state,
                    providerId,
                    modelId,
                )
                const requiredNetSavings =
                    ctx.state.nudges.recovering && recoveryTarget !== undefined
                        ? Math.max(0, getCurrentTokenUsage(ctx.state, rawMessages) - recoveryTarget)
                        : 0
                const selectionTokens = preparedPlans.reduce(
                    (total, plan) =>
                        total + estimateNewlyCompressedTokens(ctx.state, plan.selection),
                    0,
                )
                const summaryTokens = storedSummaryTokens.reduce(
                    (total, tokens) => total + tokens,
                    0,
                )
                const firstPlan = preparedPlans[0]
                const lastPlan = preparedPlans.at(-1)
                if (firstPlan && lastPlan) {
                    const failure = checkRecoveryBudget(
                        ctx.state,
                        firstPlan.entry.startId,
                        lastPlan.entry.endId,
                        selectionTokens,
                        summaryTokens,
                        requiredNetSavings,
                    )
                    if (failure) {
                        viabilityFailures.push(failure)
                    }
                }
            }
            if (viabilityFailures.length > 0) {
                // 260908 Red: 预算不足时不写入任何块，也不解除恢复态。模型会在同一轮拿到
                // 精确缺口，改选更大的范围；日常非恢复压缩不会进入这条门槛。
                return formatViabilityRejection(viabilityFailures)
            }

            const runId = allocateRunId(ctx.state)
            let totalCompressedTokens = 0
            let totalSummaryTokens = 0

            for (const preparedPlan of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary)
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: input.topic,
                        batchTopic: input.topic,
                        startId: preparedPlan.entry.startId,
                        endId: preparedPlan.entry.endId,
                        mode: "range",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    preparedPlan.selection,
                    preparedPlan.anchorMessageId,
                    blockId,
                    storedSummary,
                    preparedPlan.consumedBlockIds,
                )

                totalCompressedMessages += applied.messageIds.length
                totalCompressedTokens += applied.compressedTokens
                totalSummaryTokens += summaryTokens

                notifications.push({
                    blockId,
                    runId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return [
                `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`,
                formatCompressionOutcome(
                    ctx.state,
                    ctx.config,
                    rawMessages,
                    totalCompressedTokens,
                    totalSummaryTokens,
                ),
            ].join(" ")
        },
    })
}
