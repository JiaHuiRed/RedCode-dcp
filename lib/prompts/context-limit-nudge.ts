export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Work forward from the OLDEST uncompressed history. The oldest messages are the ones still costing you context on every single request; the block you just finished is the smallest win available and compressing only that is not a recovery.
Select a range that starts at the oldest uncompressed message and extends as far forward as is safely possible in one pass.
Leave only the newest still-active working messages uncompressed. Being recently closed is not a reason to prefer a block - prefer the oldest.
After the tool returns, read the reported context numbers. If it says you are still above the threshold, compress again immediately instead of reporting completion.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`
