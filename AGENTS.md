# AGENTS.md —— 给 AI agent 的仓库导航与纪律（人类同样适用）

> 本文件是仓库的第一入口：任何 agent（DSH 会话 / Codex / 云端 headless）在本仓库动手前先读这里。维护：内容变化时同步更新，别让它过期。

## 这是什么

dsh-work-continuity（WC）：DeepSeek Harness 的跨会话工作连续性插件。核心 = 独立 SQLite **WorkState**（goal/decisions/next steps/artifacts/unresolved）+ 三层捕获（权威事件自动捕获 goal/change、todo/write / LLM 自主决断 work_state 工具 + pre-step 摘要注入 / 显式 /checkpoint 命令）。与通用记忆（ACP）分开管理：记忆不负责替你把活干完。

## 结构地图

- `src/index.mjs` —— 插件入口（Config、service 装配、三层捕获注册、pre-step 注入、调度器上报）
- `src/store.mjs` —— WorkState SQLite 存储（node:sqlite 单连接 WAL；work_state/work_audit 两表；getStateCompat 旧桶回落）
- `client/` + `lib/client.js` + `scripts/build-client.mjs` —— Web 设置页（顶层 section「工作连续性」；改后需 build:client）
- `test/*.test.mjs` —— node:test 测试（work/golden-regression/scheduler-metering/client/config）
- `docs/` —— DEVELOPMENT-PLAN.md（backlog）、adr/（决策记录，从第一条开始写）
- `cordis.patch.yml` —— bundle 装配补丁

## 铁律（违反会被打回）

1. **WorkState 单写者**：node:sqlite 单连接 WAL；不跨进程/多实例裸写同一 work.db。
2. **workDir 必须显式**：未配置回退 $DSH_HOME/dsh-work-continuity → ~/.dsh/dsh-work-continuity；禁止相对 cwd 落库（P2-2 教训——仓库内不得出现 work.db）。
3. **事件捕获确定性**：自动捕获只消费宿主权威事件（goal/change、todo/write），不做 LLM 猜测；已有 WorkState 不被 todo 全量替换覆盖。
4. **fail-open**：插件任何异常只记日志，绝不阻断对话；done 状态不注入；内容无变化不写库（diff 门控）。
5. **改代码必须补测试**：test/ 下同名 `.test.mjs`；golden regression 套件守护历史 issue（W1-W12）。
6. **纯 ESM**：src 一律 `.mjs`；不引入运行时依赖（peerDependencies 之外需先讨论）。

## 常用命令

- 测试：`pnpm test`（node --test test/*.test.mjs）
- 单个测试：`node --test test/<name>.test.mjs`
- lint：`pnpm lint`（oxlint）
- 设置页构建：`pnpm build:client`

## 提交纪律

小步提交；每个改动一个主题；feature 分支开发；合 main 前跑全量测试。README 是中文主文档（含项目背景与使用故事），行为语义变化要同步 README 与 docs/DEVELOPMENT-PLAN.md（backlog 状态一并更新）。
