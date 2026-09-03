import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { checkViability, formatViabilityRejection, type ViabilityFailure } from "./viability"
import { formatIssues, formatResult, resolveMessages, validateArgs } from "./message-utils"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import { formatCompressionOutcome } from "./outcome"
import { appendProtectedPromptInfo, appendProtectedTools } from "./protected-content"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressMessageToolArgs } from "./types"

function buildSchema(runtimePrompts: string) {
    return {
        topic: tool.schema
            .string()
            .describe(
                "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'",
            ),
        content: tool.schema
            .array(
                tool.schema.object({
                    messageId: tool.schema
                        .string()
                        .describe("Raw message ID to compress (e.g. m0001)"),
                    topic: tool.schema
                        .string()
                        .describe("Short label (3-5 words) for this one message summary"),
                    summary: tool.schema.string().describe(runtimePrompts),
                }),
            )
            .describe("Batch of individual message summaries to create in one tool call"),
    }
}

// 260808 Red: description 保持精简，完整指令下沉到 summary 字段 describe
const MESSAGE_DESCRIPTION =
    "Collapse selected individual conversation messages into detailed summaries. " +
    "Provide messageId from the injected mNNNN IDs; read the summary field instructions."

export function createCompressMessageTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: MESSAGE_DESCRIPTION,
        args: buildSchema(runtimePrompts.compressMessage),
        async execute(args, toolCtx) {
            const input = args as CompressMessageToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Message: ${input.topic}`,
            )
            const { plans, skippedIssues, skippedCount } = resolveMessages(
                input,
                searchContext,
                ctx.state,
                ctx.config,
            )

            if (plans.length === 0 && skippedCount > 0) {
                throw new Error(formatIssues(skippedIssues, skippedCount))
            }

            const notifications: NotificationEntry[] = []

            const preparedPlans: Array<{
                plan: (typeof plans)[number]
                summaryWithTools: string
            }> = []

            for (const plan of plans) {
                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    plan.entry.summary,
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

                preparedPlans.push({
                    plan,
                    summaryWithTools,
                })
            }

            // 260903 cc: 摘要比它替换的内容还大就别落库，理由见 viability.ts。
            // message 模式一个 plan 就是一条消息，不套体积下限（那是 range 模式的判据）。
            const viabilityFailures: ViabilityFailure[] = []
            for (const { plan, summaryWithTools } of preparedPlans) {
                const failure = checkViability(
                    ctx.state,
                    plan.entry.messageId,
                    plan.entry.messageId,
                    plan.selection,
                    summaryWithTools,
                    { enforceMinimum: false },
                )
                if (failure) {
                    viabilityFailures.push(failure)
                }
            }
            if (viabilityFailures.length > 0) {
                // 拒绝即"已经没有值得压的了"：退出恢复态，否则提醒会一直逼它交差，
                // 而它只能交出更小的垃圾块。用量再次越过 max 时紧急档自会重新武装。
                ctx.state.nudges.recovering = false
                return formatViabilityRejection(viabilityFailures)
            }

            const runId = allocateRunId(ctx.state)
            let totalCompressedTokens = 0
            let totalSummaryTokens = 0

            for (const { plan, summaryWithTools } of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, summaryWithTools)
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: plan.entry.topic,
                        batchTopic: input.topic,
                        startId: plan.entry.messageId,
                        endId: plan.entry.messageId,
                        mode: "message",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    plan.selection,
                    plan.anchorMessageId,
                    blockId,
                    storedSummary,
                    [],
                )

                totalCompressedTokens += applied.compressedTokens
                totalSummaryTokens += summaryTokens

                notifications.push({
                    blockId,
                    runId,
                    summary: summaryWithTools,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return [
                formatResult(plans.length, skippedIssues, skippedCount),
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
