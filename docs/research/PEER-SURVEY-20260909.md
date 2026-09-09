---
id: DOC-RESEARCH-PEER-SURVEY-20260909
status: draft
surveyed_on: 2026-09-09
scope: dsh-work-continuity（WC）同类插件与相邻项目同行调研
---

# dsh-work-continuity 同行调研与可吸纳方法（2026-09-09）

## 0. 调研方法与范围

- **取证方式**：`gh api repos/<owner>/<repo>` 取元数据与实测星数；`gh api repos/<owner>/<repo>/readme -H "Accept: application/vnd.github.raw"` 取 README 原文落盘后逐行读；我们现状以本仓库 `AGENTS.md` / `README.md` / `docs/DEVELOPMENT-PLAN.md` 与 `src/index.mjs` / `src/store.mjs`（只读 grep）为准。
- **实测时间**：2026-09-09（星数、pushed_at 均为该次 API 返回）。gh 2.98.0，账号 Icstick。
- **没做什么**：没有 clone 或读同行源码（只读 README 与它指向的文档路径）；没有跑任何基准复现；没有做撞车/曝光判定（本次目标就是方法吸收）；`letta-ai/letta` 已归档不计入对标。
- **一处需要说明的实测差异**：本仓库 `README.md` 未提及 `handoff` 字段，但 `src/store.mjs:30` 确实建了 `handoff TEXT` 列；全仓 grep 显示它只被 store 层读写与 `clear` 置 null，**命令与 `work_state` 工具的 action 枚举里都没有 handoff**（`src/index.mjs:214-218`）。下面 §3.4 按"字段存在、能力缺失"处理。

## 1. 我们的定位（一句话）

WC 不解决"AI 忘了什么"，而解决**"跨会话的工作状态该由谁记、记成什么形状、谁有权宣布它完成"**——独立 SQLite WorkState（goal/decisions/next/artifacts/unresolved）+ 三层捕获（权威事件 / 模型工具 / 显式命令），与通用记忆分开管理。

## 2. 同行地图

| 项目 | ★ | 做什么 | 与我们的关系 |
|---|---:|---|---|
| [shengsheng90/DSH-taskboard](https://github.com/shengsheng90/DSH-taskboard) | 328 | 本地 SQLite 任务权威（项目/任务/评论/关系/附件/工作流/自动化）+ 人机权限分离 + 乐观版本 + CLI | 最接近的"状态权威"对手：它的"只有人能 accept 成 done"直接命中我们的完成权缺口 |
| [Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind) | 114 | Change Ledger：内容寻址恢复点 + 恢复前救援点 + 中断日志启动对账 + 公开 `ctx.changeLedger` 服务 | 它守的是工作区文件，我们守的是工作状态；它的"先救援再变更"可用于我们的 clear |
| [PerryLink/dsh-checkpoint-rewind](https://github.com/PerryLink/dsh-checkpoint-rewind) | 16 | 三态 checkpoint（工作区/会话游标/配置）+ 固定顺序事务 + guard checkpoint + 审批门 | 三态记录的形状提醒我们：状态与产物要分开存、分开恢复 |
| [dongsheng123132/task-passport](https://github.com/dongsheng123132/task-passport) | 11 | 任务护照（有版本、有锁、留在 store）+ TaskPack 单文件跨 harness 交接 | 跨机交接的边界处理（机器级事实降级为未证）是我们 export 的现成答案 |
| [jiezeng2004-design/dsh-requirements-alignment](https://github.com/jiezeng2004-design/dsh-requirements-alignment) | 9 | 需求基线（目标/约束/须保持行为/允许范围/已定决策）+ 方向漂移检测 + 问一次记录决定 | 我们缺的那半个 WorkState：约束与范围；它的"问一次→记录→继续"是我们的 unresolved 流程化 |
| [zhaoyuntao-wl/dsh-plugin-thread](https://github.com/zhaoyuntao-wl/dsh-plugin-thread) | 2 | 无损事件流 + 三触发结构投递（首轮锚 / 压缩后重锚 / 回合边界 delta）+ 单一 pending inbox | 三触发结构直接对上我们的注入策略；`#id` 与 inbox 是可用性范本 |
| [yuyolin/dsh-decision-log](https://github.com/yuyolin/dsh-decision-log) | 2 | 项目内 `.dsh/DECISIONS.md` + 每轮注入最新 N 条（2000 字符恒定） | 与我们的 decisions 同物；它把"恒定成本"实测摊开（100 条≈1097 token / 1000 条≈1075 token） |
| [863683348/dsh-plugin-focus](https://github.com/863683348/dsh-plugin-focus) | 2 | 焦点板（objective/constraints/decisions）持久文件 + 变更即注入 + clear 前归档 | 与我们最同源的最小实现：todo 记 next，focus board 记"为什么做、什么不能漂" |
| [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory) | 58 | 四段式 handoff（状态/目标/死路与原因/进度与下一步）+ 水位感知 + 全量归档 | 它的四段式是我们要补的 handoff 形状（尤其"死路与原因"） |
| [Qinling-Melon-Farmers/dsh-memoir](https://github.com/Qinling-Melon-Farmers/dsh-memoir) | 25 | 回合结束**提醒** agent 归纳（不静默抓取）+ 有界 Hot Memory + 来源可回溯 | 与我们"不做 LLM 猜测、写入可观察"同一条纪律 |
| [anthropics/claude-code](https://github.com/anthropics/claude-code) | 144519 | CLAUDE.md 分层记忆 + `/rewind` 会话回退 | 生态外对标：文件即状态、人可编辑；rewind 是它们对"工作连续性"的答案 |
| [openai/codex](https://github.com/openai/codex) | 122744 | AGENTS.md 按目录作用域自动发现并注入 | 我们 `/checkpoint` 与 `work_state` 的对照：它用文件层级表达作用域 |
| [cordiverse/paper](https://github.com/cordiverse/paper) | 2972 | 时空可组合性的插件范式（可卸载副作用、可重绑定依赖） | task-passport 引它论证"插件可装卸、状态在插件生命周期之外"——正是我们独立 work.db 的理由 |
| [MemTensor/MemOS](https://github.com/MemTensor/MemOS) | 11243 | L1 traces / L2 policies / L3 world model 分层 + 已官方支持 DSH | 生态内相邻：它把"工作轨迹"当 L1，我们做的是它的持久化与可查询面 |

## 3. 可吸纳的方法（核心）

### 🔴 P0

#### 1. 完成权必须留在人手里
- **出处**：[shengsheng90/DSH-taskboard](https://github.com/shengsheng90/DSH-taskboard) README "What you get" 与 "Task lifecycle"：`Agents can submit verified work to in_review. Only an authenticated human UI or CLI operation can accept it as done.`；"Human-only actions (UI or CLI, never model tools): approve, accept, return, archive, restore, cancel, reopen, force takeover, permanent delete"；"Goal completion never accepts a task. Agent success ends at `in_review`."
- **它怎么做**：模型工具集里**故意没有** accept，也没有通用 status 变更工具——只有 `taskboard_submit_review`；人通过 UI/CLI 才把任务从 `in_review` 推到 `done`，且提交时要求带证据（"Verify, then submit_review with evidence. Never edit the task description to record the result"）。
- **我们现状**：`work_state` 工具的 action 枚举含 `status`（可选 `done`）与 `done <n>`（`src/index.mjs:234-237`），`/checkpoint status done` 同样可用——**模型可以自行宣布目标完成**。`deliverable` 参数的说明写了"完成判据=实测结果而非口头自报"（`src/index.mjs:249`），但没有任何强制。`AGENTS.md` 铁律 4 的"done 状态不注入"只处理了结果，没处理写入权。
- **建议**：给 WorkState 加 `in_review` 中间态——模型只能把 goal 提到 `in_review` 并附 deliverable，`done` 由 `/checkpoint status done`（人）或具备实测证据的路径确认。

#### 2. 每次写入携带期望版本（乐观并发，防静默覆盖）
- **出处**：DSH-taskboard "Every mutation except create carries the **exact current `version`**. `TASK_STALE_VERSION` means reread and reconcile; do not retry the stale version."；[dongsheng123132/task-passport](https://github.com/dongsheng123132/task-passport) "`checkpoint`：工作完成后写回；带状态版本，过期写入直接冲突，不静默覆盖"。
- **它怎么做**：写入方必须先 get 再写，把读到的 version 一起提交；版本不匹配直接返回结构化冲突码（taskboard 的退出码 5 就是 `TASK_STALE_VERSION`），让调用方重读再合并，而不是让它覆盖别人刚写的状态。
- **我们现状**：`src/store.mjs:31` 有 `version INTEGER NOT NULL DEFAULT 1`，`save()` 每次成功写入就 +1（`src/store.mjs:103`），但**没有任何 API 接受期望版本**：`work_state` 工具参数里没有 version（`src/index.mjs:230-260`），`save()` 也不校验。因此父会话 + 子代理 + headless 实例并发写同一 scope 时是后写者静默覆盖；`work_audit` 只会记两条 `op=save`，事后无法判断谁覆盖了谁。
- **建议**：`save()` 增加可选 `expectedVersion`（不匹配返回 `{ok:false, code:'WC_STALE_VERSION', currentVersion}`），`work_state` 工具加 `version` 参数；冲突时提示"重读再写"，不自动重试。

#### 3. 压缩后重新锚定（compaction re-anchor）
- **出处**：[zhaoyuntao-wl/dsh-plugin-thread](https://github.com/zhaoyuntao-wl/dsh-plugin-thread) README "Structural delivery, three triggers — a first-turn anchor (project identity + behavior contract + status card), a re-anchor after every compaction, and a cross-agent state delta at every turn boundary. No per-turn card noise. ... the compaction re-anchor targets the 'Compaction Cliff' failure mode (arXiv:2608.22752)"。
- **它怎么做**：把注入分成三种触发而非"每轮重发同一张卡"：会话首轮打全量锚，**每次压缩后强制重锚**（因为压缩会丢掉注入过的状态），回合边界只发跨代理的增量。状态卡另有行预算 `budgetLines`（默认 200）。
- **我们现状**：`src/index.mjs:453` 的 `registerWorkStateInjection` 在 `agent/pre-step` 每轮首步注入紧凑摘要（~150 token），配合 diff 门控（内容无变化不写库、不注入）。但没有识别 compaction 事件后的重锚路径——压缩一旦发生，模型上下文里的工作摘要就没了，而 diff 门控在内容未变时不会补发（`AGENTS.md` 铁律 4"内容无变化不写库"）。
- **建议**：检测会话内 compaction 事件 → 强制重锚（绕过 diff 门控）；中期把"每轮全量摘要"改为"首轮全量 + 后续 delta"，对齐 thread 的三触发结构。

#### 4. 四段式 handoff（含"死路与原因"）
- **出处**：[Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory) README "How she hands off"："she writes a **four-part handoff note** — task state, goals, approaches tried and why they failed, progress and next step — closes this window, and opens the next. What didn't fit in the notes is safe too: the full history ... lands in a local archive."
- **它怎么做**：handoff 不是"摘要"，而是四个固定字段；其中"approaches tried and why they failed"（死路与原因）是与普通进度记录的关键区别——它避免下一个会话重走已证明无效的路径。
- **我们现状**：`src/store.mjs:30` 建了 `handoff TEXT -- JSON {summary, nextAgentHints[]} | null`，但**没有任何写入口**（`work_state` 工具与 `/checkpoint` 的 action 枚举都没有 handoff；`store.mjs:119` 只在传入时写，而调用方从不传）。也就是说"交接"这件事在数据层留了位、在能力层是空的。
- **建议**：给 `work_state` / `/checkpoint` 加 `handoff <summary>` 与 `deadend <尝试> — <为何失败>` 两个 action，`handoff` 渲染进摘要；否则删掉该列，避免"看起来有其实没有"。

#### 5. 需求基线：补上"约束"与"范围"
- **出处**：[jiezeng2004-design/dsh-requirements-alignment](https://github.com/jiezeng2004-design/dsh-requirements-alignment) README "How it works"："`establish_baseline` records the current goal, explicit constraints, must-preserve behavior, allowed scope and settled user decisions"；"What counts as drift" 列出扩/缩范围、违反显式约束、改变用户可见行为、切换架构、作废已定假设、改动已批准的用户决定等。
- **它怎么做**：把用户意图固化成一条基线（目标 + 约束 + 须保持行为 + 允许范围 + 已定决策），平时不打扰，只有当下一步会**实质性改变方向**时才走 DSH 原生 user-question 问一次并记录决定；"canonical alignment state is kept in durable sidecar storage instead of being mixed into normal DSH session events"；模式回落顺序为"会话覆盖 → 持久运行时覆盖 → profile 默认 → auto"。
- **我们现状**：WorkState 有 `goal` / `decisions` / `unresolved`，**没有 constraints / must-preserve / allowed scope**，也没有漂移检测；用户说"别动后端"这类约束目前只能塞进 decisions 文本里，模型每轮看到的摘要不会把它标成硬约束。我们的独立 `work.db` 与它"durable sidecar"的决策一致（`AGENTS.md` 铁律 1/2）。
- **建议**：加 `constraints` 与 `outOfScope` 两个字段（`/checkpoint constraint <文本>` / `outOfScope <文本>`），并在 pre-step 摘要里**固定渲染**（不参与 diff 门控的省略）。

### 🟠 P1

#### 6. 稳定 id 取代下标耦合
- **出处**：[zhaoyuntao-wl/dsh-plugin-thread](https://github.com/zhaoyuntao-wl/dsh-plugin-thread) README "Every structured row carries a visible `#id` on the status card, so memory stays human-editable end to end"；`/thread-cfm` 用 `t#id`（todos）与 `c#id`（candidates）在同一视图里操作。
- **我们现状**：`done <n>` 按"从 1 开始的 next 序号"定位（`src/index.mjs:256-259`），`next_steps` 与 `next_meta` 两个 JSON 数组靠**下标对齐**，`work_state` 的 next 分支还专门回头补写 meta（`src/index.mjs:307-322`）；WC 已有 golden 回归 W9 守这个对齐关系。下标耦合的代价是：插入或删除一条 next，后面所有条目的 meta 对齐关系全部平移（W9 正是为这个对齐关系设的回归）。
- **建议**：把 next 条目改成对象数组 `{id, text, deadline, deliverable, done}`，`done` 用 id；保留旧格式的读取兼容（`getStateCompat` 已有旧桶回落的先例）。

#### 7. 单一 pending inbox
- **出处**：DSH-thread 的 `/thread-cfm` 是"the single pending-work inbox: todos (`t#id`) and candidates (`c#id`) in one view — `do` completes/promotes, `cnl` discards, `cnl all` clears both"。
- **我们现状**：`next` 与 `unresolved` 分列两处，`/checkpoint show` 分别渲染；没有"待办合一"的视图，也没有批量清理。
- **建议**：`/checkpoint show` 增加 inbox 段（未完成 next + unresolved 合流，各带 id），并给 `done`/`resolve` 统一入口。

#### 8. 清空之前先归档
- **出处**：[863683348/dsh-plugin-focus](https://github.com/863683348/dsh-plugin-focus) "`clear` moves the old board to `.dsh/focus.md.bak` (accumulates)"；[Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind) "Rescue before mutation: every restore captures the current eligible tree as a durable rescue point before changing a path"；[PerryLink/dsh-checkpoint-rewind](https://github.com/PerryLink/dsh-checkpoint-rewind) "Rewind is reversible. Before restoring, a guard checkpoint captures the current state"。
- **我们现状**：`/checkpoint clear` 全量重置（P1-2 已修成"重置全部字段"，`src/index.mjs:620`），但**不归档**——`store.save` 直接覆盖，旧值只剩 `work_audit` 里一行 `detail`。清空是不可后悔操作。
- **建议**：`clear` 前把当前 state 序列化写进 `work_audit.detail`（或导出 md 到 `<workDir>/archive/`），保证"清空可后悔"。

#### 9. 导出时把机器级事实降级为"未证"
- **出处**：[dongsheng123132/task-passport](https://github.com/dongsheng123132/task-passport) README "三条硬规矩"之第一条："**机器级事实在打包时就被封存为未证**，并记下它曾在哪台机器上被证明（`verified_on`）。降级发生在打包这一端，不是落地那一端——否则第三方写的接收器忘了降级，假 ✓ 就进去了。**安全属性必须长在文件里，不能长在接收方身上。**"
- **我们现状**：`work_state action=export` 渲染 md 快照（`src/index.mjs:283-288`），artifacts 里常见本机绝对路径（例如 `D:\DSH_workspace\...`）。导出文件换台机器打开时，这些路径会变成"看起来已验证"的假事实。
- **建议**：export 时把本机绝对路径标注为 `unverified@<host>`，并在 md 头部写 `generated_on` / `host` / `scope`。

#### 10. 明确"未捕获即丢失"的边界，而不是全量镜像
- **出处**：DSH-thread 的"Lossless capture — subscribes to `session/event`; the full event stream lands in dual SQLite databases"与"Natural-language extraction of decisions/preferences is off — zero text-heuristic false positives; the lossless event stream remains the backstop for anything unrecorded"；反面参照是 memoir 的"不会静默抓取所有对话"。
- **我们现状**：事件层只消费两个权威事件（`goal/change`、`todo/write`，`AGENTS.md` 铁律 3），其余靠工具与命令——没有兜底。这是有意的取舍，但 README 没有把"哪些内容一定不会被记"讲清楚。
- **建议**：在 README 的"三种捕获方式"表下补一行边界说明（"未通过三层捕获的内容不会被记；插件不做全量会话镜像"）；若将来要兜底，优先存**权威事件原文**而非全量 transcript。

#### 11. 注入摘要的硬上限
- **出处**：[yuyolin/dsh-decision-log](https://github.com/yuyolin/dsh-decision-log) README "🔬 老实交代"节：每轮只注入最新一批 + 2000 字符打住，实测"100 条 ≈2060 字符 ≈1097 token；1000 条 ≈2039 字符 ≈1075 token"——本子越厚，每轮成本不变；DSH-thread 的 `budgetLines` 默认 200 行。
- **我们现状**：WC 摘要约 150 token（README），有 diff 门控，但没有**硬字符上限**；`renderWorkStateBrief`（`src/index.mjs:351`）在 next/unresolved 很多时会线性增长。
- **建议**：给摘要加硬上限（超限只渲染 goal/status/focus + 前 N 条 next + "其余 N 条见 /checkpoint show"），复刻 decision-log 的恒定成本性质。

### 🟡 P2

#### 12. SQLITE_BUSY 重试策略（若未来放宽单写者禁令）
- **出处**：DSH-thread 配置表 `busyRetries` / `busyRetryDelayMs` 默认 20 / 100，README 明确"Headless and web profiles of the same machine share the same store"。
- **我们现状**：`AGENTS.md` 铁律 1 禁止"跨进程/多实例裸写同一 work.db"（node:sqlite 单连接 WAL），所以现在不需要。
- **建议**：保持禁令；若将来允许 headless + web 共享，再引入忙重试 + 单写者锁，不要提前放宽。

#### 13. 结构化 CLI 与退出码（按需）
- **出处**：DSH-taskboard 的 JSON CLI 与退出码约定（`0` 成功、`2` 用法、`3` 存储不可用、`4` 领域错误、`5` 乐观冲突）。
- **我们现状**：只有 `/checkpoint` 命令与 `work_state` 模型工具，没有 CLI。
- **建议**：现在不做；等出现 cron/headless 批量读取的真实需求，再加 `dsh-work-continuity` CLI 与 schema 版本。

## 4. 印证我们判断的地方

- **状态权威与执行所有权分离**：taskboard 开篇就写"SQLite is the sole task authority. Harness Agent Sessions, Goals, Workspaces, tools, permissions, and the Web Client remain the execution and conversation owners."——与我们"WorkState 单写者 + 不碰工作区"是同一条边界。
- **独立存储、不混进会话事件**：requirements-alignment 明确"canonical alignment state is kept in durable sidecar storage instead of being mixed into normal DSH session events"，理由是"keeps resume/fork/compaction behavior stable"。我们 `work.db` 独立于 ACP 与会话日志，判断一致。
- **todo 与"为什么"分开**：focus 的定义句"the todo list tracks *what to do next*; the focus board tracks *why we are doing it and what must not drift*"——正是我们 goal/decisions 与 next 的分离动机。
- **写入必须可观察**：memoir"自动蒸馏是可观察的 Agent 收尾提醒，不是后台静默抓取聊天内容"；checkpoint-rewind 的"Model-visible ⟺ logged"；我们"绝不做不可见的每轮 LLM 总结"（README 设计取舍）是同一纪律。
- **决策不会自己过期**：DSH-thread"Decisions never expire on their own — close out time-bound ones with `--supersedes`"——与我们 decisions 的追加语义一致。
- **常量成本注入**：decision-log 实测 100 条与 1000 条注入成本几乎相同（≈1097 vs ≈1075 token），证实"本子可以越记越厚，但每轮只看固定的一页"——我们的 diff 门控 + 摘要注入方向正确，只缺硬上限。
- **插件可装卸、状态在其生命周期之外**：task-passport 引 [cordiverse/paper](https://github.com/cordiverse/paper)"动态插件需要可卸载的副作用和可重绑定的依赖"，因此"任务状态放在插件生命周期之外长期存在。插件消失，护照不能跟着消失"——与我们"卸载不删数据"一致。

## 5. 我们不该学的

- **不要学 taskboard 的全量任务管理**：projects / tasks / comments / relations / attachments / workflows / automation / Gantt / dashboard 是一个 issue tracker 的完整形态。WC 的边界只有五个字段（goal/decisions/next/artifacts/unresolved）——扩张成任务系统会让我们与 taskboard 正面撞车，也会让"每轮 ~150 token 摘要"这个承诺守不住。
- **不要学 rewind 类插件的文件系统快照**：turn-rewind 的 Change Ledger（内容寻址恢复点、git worktree 栅栏、救援点、恢复日志对账）与 checkpoint-rewind 的 `git stash create`/`commit-tree` 都是**工作区**恢复能力。WC 不碰文件；混进来会变成第二个备份工具，并违反"记忆不负责替你把活干完"。
- **不要学 thread 的无损全量事件流落库**：双 SQLite 存完整 `session/event` 流解决了"未记录就丢失"，代价是体积与隐私，且与 ACP 的证据账本边界重叠。WC 的捕获原则是确定性权威事件，不做全量镜像。
- **不要学 decision-log 的"说一句就记"文本触发**：它依赖用户说"记一下"或敲命令；再往前一步的自然语言自动抽取，thread 明确关掉了（"zero text-heuristic false positives"）。我们已有权威事件 + 工具两层，再加文本启发式只会引入误报。
- **不要学 task-passport 的协议化与 Provider 托管**：TaskPack 规范 + 多 Provider（U-King/本地目录/第三方）是另一个产品的边界。WC 的 export 只要能被人和别的 AI 读（md/json）就够了，不必背上协议兼容责任。

## 6. 落地建议（最多 3 条）

1. **P0-A｜完成权分离**（对应 §3.1）：`work_state` 只允许把目标推到 `in_review` 并附 deliverable，`done` 由人确认。改动集中在工具 enum 与一处状态校验，直接封掉"模型自报完成"污染跨会话状态的路径。
2. **P0-B｜`save()` 加 `expectedVersion`**（对应 §3.2）：版本冲突返回结构化错误而非静默覆盖。改动是 store 一处校验 + 工具一个参数 + 一条回归测试，收益是让多代理并发写变成可检测问题。
3. **P0-C｜handoff 死字段收口**（对应 §3.4）：要么补 `handoff`/`deadend` 两个 action 让它可用（顺带拿到四段式交接），要么删列。当前状态是数据层留位、能力层为空——这是最容易误导下一个 agent 的陷阱。

## 7. 来源清单

抓取日期均为 **2026-09-09**；标注 [原文] = 直接读取 README 原文，[元数据] = 仅 gh API 元数据。

| 来源 | 类型 | 用法 |
|---|---|---|
| https://github.com/shengsheng90/DSH-taskboard （★328） | [原文] README 379 行 | 完成权分离、乐观版本、CLI 退出码 |
| https://github.com/Anionex/dsh-turn-rewind （★114） | [原文] README 196 行 | 救援点先于变更、恢复日志对账 |
| https://github.com/PerryLink/dsh-checkpoint-rewind （★16） | [原文] README 341 行 | 三态 checkpoint、guard、固定顺序事务 |
| https://github.com/dongsheng123132/task-passport （★11） | [原文] README 242 行 | 版本冲突、机器级事实降级、verified_on |
| https://github.com/jiezeng2004-design/dsh-requirements-alignment （★9） | [原文] README 244 行 | 需求基线、漂移检测、sidecar 状态 |
| https://github.com/zhaoyuntao-wl/dsh-plugin-thread （★2） | [原文] README 179 行 | 三触发投递、compaction 重锚、#id、inbox、busy 重试 |
| https://github.com/yuyolin/dsh-decision-log （★2） | [原文] README 406 行 | 恒定成本注入实测、决策文件形状 |
| https://github.com/863683348/dsh-plugin-focus （★2） | [原文] README 130 行 | focus 与 todo 分离、clear 归档 |
| https://github.com/Aik358/dsh-auto-memory （★58） | [原文] README 481 行 | 四段式 handoff、水位感知 |
| https://github.com/Qinling-Melon-Farmers/dsh-memoir （★25） | [原文] README 243 行 | 可观察的蒸馏提醒、有界注入 |
| https://github.com/anthropics/claude-code （★144519） | [元数据] + README 参照 | 生态外对标：CLAUDE.md / rewind |
| https://github.com/openai/codex （★122744） | [元数据] + README 参照 | 生态外对标：AGENTS.md 目录作用域 |
| https://github.com/cordiverse/paper （★2972） | [元数据] + task-passport 引用 | 插件可卸载副作用、状态在生命周期之外 |
| https://github.com/MemTensor/MemOS （★11243） | [原文] README 345 行 | L1/L2/L3 分层、DSH 支持 |
| 本仓库 `AGENTS.md` / `README.md` / `docs/DEVELOPMENT-PLAN.md` / `src/index.mjs` / `src/store.mjs` | 一手 | 我们现状引用 |
