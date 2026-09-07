# dsh-work-continuity 测试

运行：`node --test test/*.test.mjs`（或 `pnpm test`）。

现状（2026-09-07 审计修正）：
- WorkState 存**独立 SQLite（work.db）**，不与 ctx.acp 共享 Ledger——旧 README「与 ctx.acp 共享 Ledger（work 域）」是规划残留，已删
- 覆盖：store 读写 / 审计 / 内容无变化门控 / 命令注册 / 注入摘要渲染（golden 套件）
- 审计修复已入 0.2.0：done 同步 next_meta（P1-1）、clear 全字段重置（P1-2）、store 落库位置根治（P2-2）
