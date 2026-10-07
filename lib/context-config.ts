export interface ModelRates {
    currency: string
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
    reasoning: number
}

export interface ContextConfig {
    maxCondensedSummaryChars: number
    maxOutputBytes: number
    maxOutputTokens: number
    maxQueryChars: number
    maxResults: number
    maxScanBytes: number
    ledgerMaxEntries: number
    rates: Record<string, ModelRates>
}

export type ContextConfigInput = Partial<ContextConfig>

const bounds = {
    maxCondensedSummaryChars: [8192, 1, 65536],
    maxOutputBytes: [8192, 512, 65536],
    maxOutputTokens: [2048, 128, 16384],
    maxQueryChars: [256, 1, 1024],
    maxResults: [10, 1, 50],
    maxScanBytes: [1048576, 1024, 8388608],
    ledgerMaxEntries: [128, 1, 1024],
} as const

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

// 261007 Red 配置拥有方统一解析默认值与安全上限；工具执行期不藏默认值。
export function resolveContextConfig(input: unknown = {}): ContextConfig {
    if (!record(input)) throw new Error("compress.contextManagement must be an object")
    for (const key of Object.keys(input)) {
        if (!(key in bounds) && key !== "rates") throw new Error(`Unknown contextManagement option: ${key}`)
    }
    const resolved = Object.fromEntries(Object.entries(bounds).map(([key, [fallback, min, max]]) => {
        const value = input[key] === undefined ? fallback : input[key]
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
            throw new Error(`contextManagement.${key} must be an integer between ${min} and ${max}`)
        }
        return [key, value]
    })) as Omit<ContextConfig, "rates">
    const rates: Record<string, ModelRates> = {}
    if (input.rates !== undefined) {
        if (!record(input.rates) || Object.keys(input.rates).length > 128) throw new Error("rates must contain at most 128 model entries")
        for (const [model, value] of Object.entries(input.rates)) {
            if (!model.length || model.length > 256 || !record(value)) throw new Error("Invalid model rates")
            if (typeof value.currency !== "string" || !/^[A-Z]{3,8}$/.test(value.currency)) throw new Error("Rates require a currency label")
            for (const key of Object.keys(value)) {
                if (!["currency", "input", "cacheRead", "cacheWrite", "output", "reasoning"].includes(key)) throw new Error(`Unknown rate: ${key}`)
            }
            const numbers = Object.fromEntries(["input", "cacheRead", "cacheWrite", "output", "reasoning"].map((key) => {
                const rate = value[key]
                if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1e6) throw new Error(`Invalid ${key} rate`)
                return [key, rate]
            })) as Omit<ModelRates, "currency">
            rates[model] = { currency: value.currency, ...numbers }
        }
    }
    return { ...resolved, rates }
}
