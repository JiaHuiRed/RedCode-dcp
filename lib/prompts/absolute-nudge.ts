export const ABSOLUTE_NUDGE = `
Context is now large in absolute terms, so each request costs more even with cache hits.

Evaluate the conversation for compressible ranges.

If any ranges are cleanly closed and unlikely to be needed again, use the compress tool on them.
If nothing is closed, do not compress: compression is a cache-reset point and costs more than it saves.
Never compress active context just to satisfy this reminder.

The goal is to filter noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
`
