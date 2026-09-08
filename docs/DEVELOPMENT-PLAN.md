# dsh-work-continuity — 开发计划与问题登记（Backlog）

> 仓库级 backlog：进行中/待办/已收口的工作条目与已知问题。
> 维护规则：条目完成即更新状态并注明提交/日期；新发现先登记再动手（规划先行）。
> 本文件初版登记来源：D:\DSH_workspace\docs\audits\plugin-code-review-2026-09-07.md（2026-09-07 全面审查）

## 版本线

| 版本 | 收口提交 | 内容 |
|---|---|---|
| 0.2.0 | a295924 | 权威事件自动捕获 P1-5、work_state 工具与 pre-step 注入 P1-6、注入调度器接线、设置顶层 section、deadline/deliverable meta、golden regression |
| 0.2.1 | 01f0a42 | T4 M4.5：注入摘要 deadline 渲染 + 逾期标记 |
| 0.3.0 | — | 待办合流（下表），版本决议：修复集不单独 bump，随特性里程碑收口 |

## 待办（Backlog）

| ID | 级别 | 问题 | 解决方式 | 状态 |
|---|---|---|---|---|
| WC-B1 | P2 | 仓库内运行时残留未删（实际位置：嵌套 dsh-work-continuity/dsh-work-continuity/，db 28KB + shm/wal，空库 0 行，无实例引用） | 删除三件套 + 空目录（.gitignore 已兜底） | ✅ 2026-09-08 删除（e8c26d8 批次清理） |
| WC-B2 | P3 | COMMAND_DESCRIPTION.zh 定义未使用（index.mjs:59-66），注册只取 .en（:527-528）——半成品 i18n | 描述扁平化为中文（与 ACP 命令及 work_state 工具一致；宿主无 per-locale 机制） | ✅ 2026-09-08 6a7fc55 |
| WC-B3 | P3 | CONTRACTS.md 跨仓库注释引用 ×3（index.mjs:3、store.mjs:3/49）指向 acp-docs/CONTRACTS.md 无链接 | 注释补定位（独立文档库 my-plugins/acp-docs/） | ✅ 2026-09-08 6a7fc55 |
| WC-B4 | P3 | README 设计取舍节"work_audit 审计回溯"表述偏高：实际无明细查询命令（仅 /checkpoint stats 聚合 + 落库留痕） | README 改"全部写入 work_audit 留痕（/checkpoint stats 聚合可见）"；若需明细查询面另排 | ✅ 2026-09-08 6a7fc55 |
| WC-B5 | P3 | lint warnings 14 个（0 error）：src/index.mjs:522 未用参数、client/index.js:133/137 unicorn spread fallback、test 9 个未用 t 参数（实查） | 一次 lint-clean 提交（`pnpm lint` 归零；42/42 测试绿） | ✅ 2026-09-08 6a7fc55 |
| WC-B6 | P3 | git 残留分支 ×2（已并入 master）：docs/pr-template、feat/scheduler-metering | git-guardrails 流程：本地 branch -d + push origin --delete（均已合并，无强删） | ✅ 2026-09-08（本地+远端已删） |
| WC-B7 | 计划 | work_audit 明细查询面（可选）：按 scope/op 查审计明细 | 若需要再做（当前 stats 足够）；不排期 | 未排期 |
| WC-B8 | P3 | S2 迁移影响：运行时零依赖 memento/ACP；2 条历史注释（index.mjs:7、withService 处）措辞中性化 | 随 WC-B3 注释批次一并处理 | ✅ 2026-09-08 6a7fc55 |

## 已收口（近期）

- P1-1（done <n> 不同步 next_meta）✅ 0d5057b —— golden W9
- P1-2（/checkpoint clear 不全量重置）✅ 0d5057b —— golden W10
- P2-2（store 落库位置：DSH_HOME 缺失不落 cwd）✅ 2026-09-07 —— openWorkStore 兜底 $DSH_HOME → ~/.dsh；回归测试 work.test.mjs:326
- README/test-README 同步（审计 §五差异 1-4）✅ c212b46
- T4 M4.5（deadline 渲染 + 逾期标记）✅ c54c22c（W11/W12）
