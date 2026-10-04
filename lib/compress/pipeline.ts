import type { WithParts } from "../state"
import { ensureSessionInitialized, refreshManualMode } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    await refreshManualMode(ctx.state, toolCtx.sessionID, ctx.logger, ctx.config.manualMode.enabled)

    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
    )

    assignMessageRefs(ctx.state, rawMessages)

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    if (ctx.state.manualMode === "compress-pending") {
        ctx.state.manualMode = false
        await refreshManualMode(
            ctx.state,
            toolCtx.sessionID,
            ctx.logger,
            ctx.config.manualMode.enabled,
        )
    }
    applyPendingCompressionDurations(ctx.state)
    await saveSessionState(ctx.state, ctx.logger)

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        ctx.state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
    )

    // 261004 Red 只附加数字回执；摘要、工具返回文本与触发策略保持原样。
    if (entries.length === 0) return
    const blocks = entries.map((entry) => ctx.state.prune.messages.blocksById.get(entry.blockId))
    if (blocks.some((block) => !block)) {
        ctx.logger.warn("Compression evidence unavailable: completed block missing", {
            sessionId: toolCtx.sessionID,
        })
        return
    }
    const completed = blocks.filter((block) => block !== undefined)
    const created = new Set(completed.map((block) => block.blockId))
    const consumed = [...new Set(completed.flatMap((block) => block.consumedBlockIds))]
        .filter((id) => !created.has(id))
        .map((id) => ctx.state.prune.messages.blocksById.get(id))
    if (consumed.some((block) => !block)) {
        ctx.logger.warn("Compression evidence unavailable: consumed block missing", {
            sessionId: toolCtx.sessionID,
        })
        return
    }
    const inputTokensEstimated =
        completed.reduce((sum, block) => sum + block.compressedTokens, 0) +
        consumed.reduce((sum, block) => sum + (block?.summaryTokens ?? 0), 0)
    const summaryTokensEstimated = completed.reduce((sum, block) => sum + block.summaryTokens, 0)
    toolCtx.metadata({
        metadata: {
            dcpCompression: {
                version: 1,
                runId: entries[0]!.runId,
                blockCount: completed.length,
                inputTokensEstimated,
                summaryTokensEstimated,
                netSavingsEstimated: inputTokensEstimated - summaryTokensEstimated,
            },
        },
    })
}
