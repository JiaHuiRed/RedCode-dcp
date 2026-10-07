import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import { fetchSessionMessages } from "./compress/search"
import { resolveContextConfig, type ContextConfig } from "./context-config"
import { countTokens } from "./token-utils"
import { resolveEffectiveCompressPermission, resolveEffectiveToolPermission, type HostPermissionSnapshot } from "./host-permissions"
import type { WithParts } from "./state"

type Document = { ref: string; kind: "message" | "block"; text: string }

// 261007 Red 先按字符数缩小候选，再按 UTF-8 字节裁剪；不分割代理对。
export function utf8Prefix(text: string, maxBytes: number): string {
    let low = 0
    let high = Math.min(text.length, maxBytes)
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle
        else high = middle - 1
    }
    if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--
    return text.slice(0, low)
}

export function boundedJson(value: { results: Record<string, unknown>[]; truncated: boolean; scannedBytes?: number }, limits: ContextConfig): string {
    const result = { ...value, results: value.results.map((item) => ({ ...item })) }
    let output = JSON.stringify(result)
    while (Buffer.byteLength(output, "utf8") > limits.maxOutputBytes || countTokens(output) > limits.maxOutputTokens) {
        result.truncated = true
        const last = result.results.at(-1)
        if (!last) throw new Error("Retrieval metadata exceeds configured output budget")
        const text = typeof last.text === "string" ? last.text : typeof last.snippet === "string" ? last.snippet : ""
        if (text.length > 16) {
            const field = typeof last.text === "string" ? "text" : "snippet"
            const shortened = utf8Prefix(text, Math.floor(Buffer.byteLength(text) * 0.75))
            last[field] = shortened
            last.truncated = true
            if (typeof last.offset === "number") last.nextOffset = last.offset + shortened.length
        } else result.results.pop()
        output = JSON.stringify(result)
    }
    return output
}

function* messageChunks(message: WithParts): Generator<string> {
    let started = false
    for (const part of message.parts) {
        const content = part.type === "text" || part.type === "reasoning"
            ? part.text
            : part.type === "tool" && part.state.status === "completed" ? part.state.output
            : part.type === "tool" && part.state.status === "error" ? part.state.error : ""
        if (!content) continue
        if (started) yield "\n"
        yield content
        started = true
    }
}

// 261007 Red 跳过前文只累计长度，按请求窗口取回；续读不受此前扫描上限限制。
export function readMessageWindow(message: WithParts, offset: number, limit: number, maxBytes: number) {
    let totalLength = 0
    let text = ""
    let limited = false
    for (const chunk of messageChunks(message)) {
        const start = Math.max(0, offset - totalLength)
        const end = Math.min(chunk.length, offset + limit - totalLength)
        if (start < end && !limited) {
            if (start > 0 && /[\uDC00-\uDFFF]/.test(chunk[start]!)) throw new Error("Offset splits a Unicode character")
            const remaining = maxBytes - Buffer.byteLength(text)
            const candidate = chunk.slice(start, end)
            const selected = remaining > 0 ? utf8Prefix(candidate, remaining) : ""
            text += selected
            limited = selected.length < candidate.length
        }
        totalLength += chunk.length
    }
    if (offset > totalLength) throw new Error("Offset is beyond available content")
    return { text, totalLength }
}

export function createRetrievalTools(ctx: ToolContext, permissions: HostPermissionSnapshot): Record<"dcp_search" | "dcp_read", ReturnType<typeof tool>> {
    const limits = resolveContextConfig(ctx.config.compress.contextManagement)
    const snapshot = async (name: string, toolCtx: { sessionID: string; agent: string; ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void> }, pattern = "*") => {
        if (ctx.state.sessionId !== toolCtx.sessionID) throw new Error("DCP session changed; retry in the active session")
        if (ctx.state.isSubAgent && !ctx.config.experimental.allowSubAgents) throw new Error("DCP retrieval is disabled in subagents")
        if (resolveEffectiveCompressPermission(ctx.config.compress.permission, permissions, toolCtx.agent) === "deny" ||
            resolveEffectiveToolPermission(name, ctx.config.compress.permission, permissions, toolCtx.agent) === "deny") {
            throw new Error("DCP retrieval permission denied")
        }
        await toolCtx.ask({ permission: name, patterns: [pattern], always: ["*"], metadata: {} })
        if (ctx.state.sessionId !== toolCtx.sessionID) throw new Error("DCP session changed during permission check")
        const sessionID = toolCtx.sessionID
        const refs = new Map(ctx.state.messageIds.byRawId)
        const blocks = [...ctx.state.prune.messages.blocksById.values()].map((block) => ({
            ref: `b${block.blockId}`, kind: "block" as const, text: block.summary,
        }))
        const messages = await fetchSessionMessages(ctx.client, sessionID)
        if (ctx.state.sessionId !== sessionID || messages.some((message) => message.info.sessionID !== sessionID)) {
            throw new Error("DCP session changed during retrieval")
        }
        return { messages, refs, blocks }
    }
    return {
        dcp_search: tool({
            description: "Search archived summaries and original messages in this session. Returns bounded literal-match snippets without changing active history.",
            args: { query: tool.schema.string().min(1).max(limits.maxQueryChars) },
            async execute(args, toolCtx) {
                if (!args.query.trim() || args.query.length > limits.maxQueryChars) throw new Error("Invalid retrieval query")
                const { messages, refs, blocks } = await snapshot("dcp_search", toolCtx)
                const results: Record<string, unknown>[] = []
                let scannedBytes = 0
                let truncated = false
                const query = args.query.toLocaleLowerCase()
                function* documents(): Generator<Document> {
                    yield* blocks
                    for (const message of messages) {
                        const ref = refs.get(message.info.id)
                        if (ref) yield { ref, kind: "message", text: readMessageWindow(message, 0, limits.maxScanBytes, limits.maxScanBytes - scannedBytes).text }
                    }
                }
                for (const document of documents()) {
                    const text = utf8Prefix(document.text, limits.maxScanBytes - scannedBytes)
                    scannedBytes += Buffer.byteLength(text)
                    const index = text.toLocaleLowerCase().indexOf(query)
                    if (index >= 0) {
                        const offset = Math.max(0, index - 80)
                        results.push({ ref: document.ref, kind: document.kind, offset, snippet: utf8Prefix(text.slice(offset), 512) })
                    }
                    if (scannedBytes >= limits.maxScanBytes || results.length >= limits.maxResults) {
                        truncated = true
                        break
                    }
                }
                return boundedJson({ results, truncated, scannedBytes }, limits)
            },
        }),
        dcp_read: tool({
            description: "Read an original message or archived block by mNNNN/bN reference in this session. Offset/limit use UTF-16 character indices; nextOffset supports bounded continuation.",
            args: {
                ref: tool.schema.string().max(32),
                offset: tool.schema.number().int().nonnegative().optional(),
                limit: tool.schema.number().int().positive().max(limits.maxScanBytes).optional(),
            },
            async execute(args, toolCtx) {
                if (!/^(m\d+|b[1-9]\d*)$/.test(args.ref)) throw new Error("Invalid retrieval reference")
                const { messages, refs, blocks } = await snapshot("dcp_read", toolCtx, args.ref)
                const block = blocks.find((item) => item.ref === args.ref)
                const message = messages.find((item) => refs.get(item.info.id) === args.ref)
                const offset = args.offset ?? 0
                const limit = args.limit ?? limits.maxOutputBytes
                if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxScanBytes) throw new Error("Invalid read bounds")
                if (!block && !message) throw new Error("Archived reference is unavailable in this session")
                if (block && offset > block.text.length) throw new Error("Offset is beyond available content")
                if (block && offset > 0 && /[\uDC00-\uDFFF]/.test(block.text[offset]!)) throw new Error("Offset splits a Unicode character; use the returned nextOffset")
                const window = block
                    ? { text: utf8Prefix(block.text.slice(offset, offset + limit), limits.maxOutputBytes), totalLength: block.text.length }
                    : readMessageWindow(message!, offset, limit, limits.maxOutputBytes)
                const truncated = offset + window.text.length < window.totalLength
                return boundedJson({
                    results: [{ ref: args.ref, kind: block ? "block" : "message", offset, text: window.text, totalLength: window.totalLength, nextOffset: offset + window.text.length, truncated }],
                    truncated,
                }, limits)
            },
        }),
    }
}
