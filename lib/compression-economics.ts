import type { SessionState, WithParts } from "./state"
import type { ContextConfig, ModelRates } from "./context-config"
import { resolveContextConfig } from "./context-config"

export interface ObservedUsage {
    messageId: string
    model: string
    time: number
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
    reasoning: number
}

export interface EconomicsEntry {
    runId: number
    messageId: string
    blockIds: number[]
    createdAt: number
    inputTokensEstimated: number
    summaryTokensEstimated: number
    netSavingsEstimated: number
    generatingUsage?: ObservedUsage
    rates?: ModelRates
}

export interface EconomicsState {
    entries: EconomicsEntry[]
    usage: ObservedUsage[]
    partial: boolean
}

export function createEconomicsState(): EconomicsState {
    return { entries: [], usage: [], partial: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function parseUsage(value: unknown): ObservedUsage | undefined {
    if (!isRecord(value) || typeof value.messageId !== "string" || value.messageId.length > 256 ||
        typeof value.model !== "string" || value.model.length > 512 ||
        !["time", "input", "cacheRead", "cacheWrite", "output", "reasoning"].every((key) => validNumber(value[key]))) return
    return {
        messageId: value.messageId, model: value.model, time: value.time as number,
        input: value.input as number, cacheRead: value.cacheRead as number,
        cacheWrite: value.cacheWrite as number, output: value.output as number, reasoning: value.reasoning as number,
    }
}

export function loadEconomicsState(value: unknown): EconomicsState {
    const state = createEconomicsState()
    if (!isRecord(value)) return state
    state.partial = value.partial === true
    if (Array.isArray(value.usage)) {
        state.usage = value.usage.slice(-1024).flatMap((item) => {
            const parsed = parseUsage(item)
            return parsed ? [parsed] : []
        })
        state.partial ||= value.usage.length > 1024
    }
    if (Array.isArray(value.entries)) {
        for (const item of value.entries.slice(-1024)) {
            if (!isRecord(item) || typeof item.messageId !== "string" || item.messageId.length > 256 ||
                !validNumber(item.runId) || !validNumber(item.createdAt) ||
                !validNumber(item.inputTokensEstimated) || !validNumber(item.summaryTokensEstimated) ||
                !Array.isArray(item.blockIds) || item.blockIds.length > 1024 ||
                !item.blockIds.every(validNumber)) continue
            let rates: ModelRates | undefined
            if (item.rates !== undefined) {
                try {
                    rates = resolveContextConfig({ rates: { persisted: item.rates } }).rates.persisted
                } catch {
                    // 261007 Red 损坏的历史费率只丢弃估算，不阻止恢复压缩块。
                    state.partial = true
                }
            }
            state.entries.push({
                runId: item.runId, messageId: item.messageId, blockIds: item.blockIds,
                createdAt: item.createdAt, inputTokensEstimated: item.inputTokensEstimated,
                summaryTokensEstimated: item.summaryTokensEstimated,
                netSavingsEstimated: item.inputTokensEstimated - item.summaryTokensEstimated,
                generatingUsage: parseUsage(item.generatingUsage),
                rates,
            })
        }
        state.partial ||= value.entries.length > 1024
    }
    return state
}

export function recordEconomics(
    state: SessionState,
    entry: Omit<EconomicsEntry, "createdAt" | "netSavingsEstimated">,
    limits: ContextConfig,
): void {
    const ledger = state.economics ??= createEconomicsState()
    if (ledger.entries.some((item) => item.runId === entry.runId && item.messageId === entry.messageId)) return
    ledger.entries.push({
        ...entry, createdAt: Date.now(),
        netSavingsEstimated: entry.inputTokensEstimated - entry.summaryTokensEstimated,
    })
    if (ledger.entries.length > limits.ledgerMaxEntries) {
        ledger.entries.splice(0, ledger.entries.length - limits.ledgerMaxEntries)
        ledger.partial = true
    }
}

// 261007 Red 记录未裁剪的已结束请求；output 为宿主已归一化的可见输出，reasoning 单列。
export function syncEconomics(state: SessionState, messages: WithParts[], limits: ContextConfig): boolean {
    const ledger = state.economics ??= createEconomicsState()
    const before = JSON.stringify(ledger)
    for (const message of messages) {
        const info = message.info
        if (info.role !== "assistant" || !info.time.completed) continue
        const usage = parseUsage({
            messageId: info.id, model: `${info.providerID}/${info.modelID}`, time: info.time.created,
            input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning,
            cacheRead: info.tokens.cache.read, cacheWrite: info.tokens.cache.write,
        })
        if (!usage || usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite === 0) continue
        const index = ledger.usage.findIndex((item) => item.messageId === usage.messageId)
        if (index >= 0) ledger.usage[index] = usage
        else ledger.usage.push(usage)
        for (const entry of ledger.entries) {
            if (entry.messageId !== usage.messageId) continue
            entry.generatingUsage = usage
            entry.rates = limits.rates[usage.model] ?? entry.rates
        }
    }
    if (ledger.usage.length > limits.ledgerMaxEntries) {
        ledger.usage.splice(0, ledger.usage.length - limits.ledgerMaxEntries)
        ledger.partial = true
    }
    return before !== JSON.stringify(ledger)
}

export function estimateEconomics(state: SessionState, entry: EconomicsEntry) {
    const active = entry.blockIds.every((id) => state.prune.messages.blocksById.get(id)?.active === true)
    const usage = entry.generatingUsage
    const rates = entry.rates
    if (!active || !usage || !rates) return { status: "unknown" as const, active, actualSavings: "unknown" as const }
    const wholeTurnCost = (
        usage.input * rates.input + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite +
        usage.output * rates.output + usage.reasoning * rates.reasoning
    ) / 1e6
    const perCachedRequestBenefit = Math.max(0, entry.netSavingsEstimated) * rates.cacheRead / 1e6
    const firstPost = state.economics?.usage.filter((sample) => sample.time > entry.createdAt && sample.model === usage.model).sort((a, b) => a.time - b.time)[0]
    const assumedRewarm = firstPost ? (
        firstPost.input * Math.max(0, rates.input - rates.cacheRead) +
        firstPost.cacheWrite * Math.max(0, rates.cacheWrite - rates.cacheRead)
    ) / 1e6 : undefined
    return {
        status: "estimated" as const, active, actualSavings: "unknown" as const,
        attribution: "whole-generating-turn" as const, currency: rates.currency,
        wholeTurnCost, perCachedRequestBenefit, assumedRewarm,
        breakEvenRequests: assumedRewarm === undefined || perCachedRequestBenefit <= 0
            ? undefined : Math.ceil((wholeTurnCost + assumedRewarm) / perCachedRequestBenefit),
        assumption: "Entire generation turn and all first-postfold miss/write premium charged to compression; cached reuse assumed. Not measured incremental cost or subscription quota.",
    }
}

export function formatEconomics(state: SessionState): string {
    const ledger = state.economics
    if (!ledger?.entries.length) return "\nCompression economics: unknown (no receipts)."
    const rows = ledger.entries.slice(-5).map((entry) => {
        const estimate = estimateEconomics(state, entry)
        return estimate.status === "unknown"
            ? `  Run ${entry.runId}: net ~${entry.netSavingsEstimated}; cost/payback unknown${estimate.active ? "" : " (inactive/superseded)"}`
            : `  Run ${entry.runId}: net ~${entry.netSavingsEstimated}; whole-turn ~${estimate.wholeTurnCost.toFixed(6)} ${estimate.currency}; assumed payback ${estimate.breakEvenRequests ?? "unknown"} requests`
    })
    return [
        "\nCompression economics (estimates, not measured savings or subscription quota):",
        ...rows,
        ledger.partial ? "  Partial bounded ledger; older entries omitted." : "",
        "  Payback assumes cached reuse; all first-postfold miss/write premium counted as rewarm, not proven attribution.",
    ].filter(Boolean).join("\n")
}
