export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Work forward from the OLDEST uncompressed history. The oldest messages are the ones still costing you context on every single request; the block you just finished is the smallest win available and compressing only that is not a recovery.
A RECOVERY BUDGET section below gives you the exact deficit and the cumulative size of the oldest history by end point. Use it: take the listed startId, and take the endId whose cumulative size covers the budget. Do not choose a smaller range than the budget requires.
Leave only the newest still-active working messages uncompressed. Being recently closed is not a reason to prefer a block - prefer the oldest.
This must be ONE pass. Every extra compression rewrites history and resets the prefix cache, so a range that stops short costs more than the one large range you should have picked.
If the tool rejects your selection as unable to pay for itself, do not retry with a similar range - either select a substantially larger one or report that the remaining history is already compressed.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`
