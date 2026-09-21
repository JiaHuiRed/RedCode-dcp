# DCP — RedCode 定制版动态上下文裁剪插件

基于上游 [opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) 的定制仓：分级压缩触发（劝说档 min / 强制档 max / 收益档 absolute nudge）、锚定 nudge（预算表只挂最新锚）、每会话告警。

## 验证命令（从仓库根跑）

- `bun run typecheck` — tsc --noEmit
- `bun test` — 全量 21 个测试文件。已知基线失败：`prompts.test.ts` 的 "system prompt overrides handle reminder tags safely"（260921 确认改动前即挂，与本仓常规改动无关；修它是另一回事）
- `npm run build` — clean + tsup + tsc --emitDeclarationOnly → `dist/index.js`（dist 不入库）

## 本仓红线

- **改码必 `npm run build` + 重启会话**。loader 动态 import `dist/index.js`，只改源码不重建 = 白改（260826 实证）。
- **dcp.jsonc 两张触发线表必须成对补**：`modelMinLimits` / `modelMaxLimits`，detectModelLimitMiss 是逐表判的，漏一张照样告警回落。校验规则：`max < context` 且 `min < 80% context`。
- **新 provider / 新模型接入必回来补键**。判据：contextWindow ≥ 500k 的模型两张表必须有键（小窗口模型配大线反而让紧急档永不触发）。缺键静默回落全局默认 50k/100k——此坑五犯（260811/260902/260904/260910/260921），已有每会话告警门禁（warnedModelLimitKeys），补键仍是唯一根治。
- **per-session 状态挂 SessionState**：`createSessionState` 初始化、`resetSessionState` 重置成对写；禁止模块级可变状态做去重——进程级去重让告警每进程只响一次，是五犯间隔那么长的帮凶（0059401）。
- **token 口径单源**：selection 侧与未压缩账本展示共用 `countAllMessageTokens` 现算值，禁用历史记录值混算（260910 教训：口径混用虚高 8.8K，恢复判据永远差一截、每次提交被拒）。
- **nudge 文本是模型可见改动**：改模板 / 锚定策略 / 注入时机，按主仓 AGENTS.md 的「模型可见改动四问」过一遍（改了什么 / token 增减 / KV cache 影响面 / 有无硬上限）。

## 配置

- `dcp.jsonc` 真身在私仓 `~/.redcode/dcp.jsonc`（两机同步靠私仓 git）；`~/.config/opencode/dcp.jsonc` 是指向它的软链。改配置改真身，改完重启会话生效。

## commit

- scope 按子系统：`compress` / `alert` / `state` / `memory` / `prompt` / `test`
- AI commit 加 `[Karina] ` / `[YuQi] ` 前缀；标题下空一行写正文，说清为什么
