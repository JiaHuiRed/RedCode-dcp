import type { CompressionBlock, SessionState } from "../state"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import type {
    BoundaryReference,
    CompressRangeToolArgs,
    InjectedSummaryResult,
    ParsedBlockPlaceholder,
    ResolvedRangeCompression,
    SearchContext,
} from "./types"

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

export function validateArgs(args: CompressRangeToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.startId !== "string" || entry.startId.trim().length === 0) {
            throw new Error(`${prefix}.startId is required and must be a non-empty string`)
        }

        if (typeof entry?.endId !== "string" || entry.endId.trim().length === 0) {
            throw new Error(`${prefix}.endId is required and must be a non-empty string`)
        }

        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }
    }
}

export function resolveRanges(
    args: CompressRangeToolArgs,
    searchContext: SearchContext,
    state: SessionState,
): ResolvedRangeCompression[] {
    return args.content.map((entry, index) => {
        const normalizedEntry = {
            startId: entry.startId.trim(),
            endId: entry.endId.trim(),
            summary: entry.summary,
            condensedSummaries: entry.condensedSummaries,
        }

        const { startReference, endReference } = resolveBoundaryIds(
            searchContext,
            state,
            normalizedEntry.startId,
            normalizedEntry.endId,
        )
        const selection = resolveSelection(searchContext, startReference, endReference)

        return {
            index,
            entry: normalizedEntry,
            selection,
            anchorMessageId: resolveAnchorMessageId(startReference),
        }
    })
}

export function validateNonOverlapping(plans: ResolvedRangeCompression[]): void {
    const sortedPlans = [...plans].sort(
        (left, right) =>
            left.selection.startReference.rawIndex - right.selection.startReference.rawIndex ||
            left.selection.endReference.rawIndex - right.selection.endReference.rawIndex ||
            left.index - right.index,
    )

    const issues: string[] = []

    for (let index = 1; index < sortedPlans.length; index++) {
        const previous = sortedPlans[index - 1]
        const current = sortedPlans[index]
        if (!previous || !current) {
            continue
        }

        if (current.selection.startReference.rawIndex > previous.selection.endReference.rawIndex) {
            continue
        }

        issues.push(
            `content[${previous.index}] (${previous.entry.startId}..${previous.entry.endId}) overlaps content[${current.index}] (${current.entry.startId}..${current.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }
}

export function parseBlockPlaceholders(summary: string): ParsedBlockPlaceholder[] {
    const placeholders: ParsedBlockPlaceholder[] = []
    const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX)

    let match: RegExpExecArray | null
    while ((match = regex.exec(summary)) !== null) {
        const full = match[0]
        const blockIdPart = match[1] || match[2]
        const parsed = Number.parseInt(blockIdPart, 10)
        if (!Number.isInteger(parsed)) {
            continue
        }

        placeholders.push({
            raw: full,
            blockId: parsed,
            startIndex: match.index,
            endIndex: match.index + full.length,
        })
    }

    return placeholders
}

export function validateSummaryPlaceholders(
    placeholders: ParsedBlockPlaceholder[],
    requiredBlockIds: number[],
    startReference: BoundaryReference,
    endReference: BoundaryReference,
    summaryByBlockId: Map<number, CompressionBlock>,
): number[] {
    const boundaryOptionalIds = new Set<number>()
    if (startReference.kind === "compressed-block") {
        if (startReference.blockId === undefined) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        boundaryOptionalIds.add(startReference.blockId)
    }
    if (endReference.kind === "compressed-block") {
        if (endReference.blockId === undefined) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        boundaryOptionalIds.add(endReference.blockId)
    }

    const strictRequiredIds = requiredBlockIds.filter((id) => !boundaryOptionalIds.has(id))
    const requiredSet = new Set(requiredBlockIds)
    const keptPlaceholderIds = new Set<number>()
    const validPlaceholders: ParsedBlockPlaceholder[] = []

    for (const placeholder of placeholders) {
        const isKnown = summaryByBlockId.has(placeholder.blockId)
        const isRequired = requiredSet.has(placeholder.blockId)
        const isDuplicate = keptPlaceholderIds.has(placeholder.blockId)

        if (isKnown && isRequired && !isDuplicate) {
            validPlaceholders.push(placeholder)
            keptPlaceholderIds.add(placeholder.blockId)
        }
    }

    placeholders.length = 0
    placeholders.push(...validPlaceholders)

    return strictRequiredIds.filter((id) => !keptPlaceholderIds.has(id))
}

export function injectBlockPlaceholders(
    summary: string,
    placeholders: ParsedBlockPlaceholder[],
    summaryByBlockId: Map<number, CompressionBlock>,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
    condensed: ReadonlyMap<number, string> = new Map(),
): InjectedSummaryResult {
    let cursor = 0
    let expanded = summary
    const consumed: number[] = []
    const consumedSeen = new Set<number>()

    if (placeholders.length > 0) {
        expanded = ""
        for (const placeholder of placeholders) {
            const target = summaryByBlockId.get(placeholder.blockId)
            if (!target) {
                throw new Error(`Compressed block not found: (b${placeholder.blockId})`)
            }

            expanded += summary.slice(cursor, placeholder.startIndex)
            expanded += condensed.get(target.blockId) ?? restoreSummary(target.summary)
            cursor = placeholder.endIndex

            if (!consumedSeen.has(placeholder.blockId)) {
                consumedSeen.add(placeholder.blockId)
                consumed.push(placeholder.blockId)
            }
        }

        expanded += summary.slice(cursor)
    }

    expanded = injectBoundarySummary(
        expanded,
        startReference,
        "start",
        summaryByBlockId,
        consumed,
        consumedSeen,
        condensed,
    )
    expanded = injectBoundarySummary(
        expanded,
        endReference,
        "end",
        summaryByBlockId,
        consumed,
        consumedSeen,
        condensed,
    )

    return {
        expandedSummary: expanded,
        consumedBlockIds: consumed,
    }
}

export function appendMissingBlockSummaries(
    summary: string,
    missingBlockIds: number[],
    summaryByBlockId: Map<number, CompressionBlock>,
    consumedBlockIds: number[],
    condensed: ReadonlyMap<number, string> = new Map(),
): InjectedSummaryResult {
    const consumedSeen = new Set<number>(consumedBlockIds)
    const consumed = [...consumedBlockIds]

    const missingSummaries: string[] = []
    for (const blockId of missingBlockIds) {
        if (consumedSeen.has(blockId)) {
            continue
        }

        const target = summaryByBlockId.get(blockId)
        if (!target) {
            throw new Error(`Compressed block not found: (b${blockId})`)
        }

        missingSummaries.push(`\n### (b${blockId})\n${condensed.get(blockId) ?? restoreSummary(target.summary)}`)
        consumedSeen.add(blockId)
        consumed.push(blockId)
    }

    if (missingSummaries.length === 0) {
        return {
            expandedSummary: summary,
            consumedBlockIds: consumed,
        }
    }

    const heading =
        "\n\nThe following previously compressed summaries were also part of this conversation section:"

    return {
        expandedSummary: summary + heading + missingSummaries.join(""),
        consumedBlockIds: consumed,
    }
}

export function restoreSummary(summary: string): string {
    const headerMatch = summary.match(/^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i)
    if (!headerMatch) {
        return summary
    }

    const afterHeader = summary.slice(headerMatch[0].length)
    const withoutLeadingBreaks = afterHeader.replace(/^(?:\r?\n)+/, "")
    return withoutLeadingBreaks
        .replace(/(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "")
        .replace(/(?:\r?\n)+$/, "")
}

function injectBoundarySummary(
    summary: string,
    reference: BoundaryReference,
    position: "start" | "end",
    summaryByBlockId: Map<number, CompressionBlock>,
    consumed: number[],
    consumedSeen: Set<number>,
    condensed: ReadonlyMap<number, string>,
): string {
    if (reference.kind !== "compressed-block" || reference.blockId === undefined) {
        return summary
    }
    if (consumedSeen.has(reference.blockId)) {
        return summary
    }

    const target = summaryByBlockId.get(reference.blockId)
    if (!target) {
        throw new Error(`Compressed block not found: (b${reference.blockId})`)
    }

    const injectedBody = condensed.get(target.blockId) ?? restoreSummary(target.summary)
    const left = position === "start" ? injectedBody.trim() : summary.trim()
    const right = position === "start" ? summary.trim() : injectedBody.trim()
    const next = !left ? right : !right ? left : `${left}\n\n${right}`

    consumedSeen.add(reference.blockId)
    consumed.push(reference.blockId)
    return next
}

const protectedHeadings = [
    "The following user messages were sent in this conversation verbatim:",
    "The following protected prompt information was included in this conversation verbatim:",
    "The following protected tools were used in this conversation as well:",
]

export function protectedTail(summary: string): string | undefined {
    const body = restoreSummary(summary)
    const positions = protectedHeadings.map((heading) => body.indexOf(heading)).filter((index) => index >= 0)
    return positions.length ? body.slice(Math.min(...positions)) : undefined
}

// 261007 Red 旧块无保护来源标记时保守回填全文；保护内容绝不交给模型二次概括。
export function resolveCondensedSummaries(
    overrides: Record<string, string> | undefined,
    required: number[],
    blocks: Map<number, CompressionBlock>,
    maxChars: number,
): Map<number, string> {
    const result = new Map<number, string>()
    if (overrides === undefined) return result
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("condensedSummaries must be an object")
    for (const [ref, text] of Object.entries(overrides)) {
        const id = /^b[1-9]\d*$/.test(ref) ? Number(ref.slice(1)) : NaN
        const block = blocks.get(id)
        if (!block || !required.includes(id)) throw new Error(`Condensed block is not selected: ${ref}`)
        if (typeof text !== "string" || !text.trim() || text.length > maxChars) throw new Error(`Invalid condensed summary: ${ref}`)
        if (parseBlockPlaceholders(text).length) throw new Error("Condensed summaries must be self-contained without block placeholders")
        const tail = protectedTail(block.summary)
        const body = tail !== undefined
            ? `${text.trim()}\n\n${tail}`
            : block.protectedContentKnown === true ? text.trim() : restoreSummary(block.summary)
        result.set(id, body)
    }
    return result
}
