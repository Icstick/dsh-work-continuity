# dsh-work-continuity

DeepSeek Harness (dsh) 的 **Work Continuity** 插件——跨会话的工作状态显式持久化，和通用记忆分开管理。

> 设计铁律（与 ACP 一致）：**记忆不负责替你把活干完。**
> 目标、决策、下一步这些工作状态，不该混在记忆里被遗忘或被乱注入——它们是独立管理、随时可查的。

## 为什么需要它

和 agent 干活的人应该都熟这个场景：昨天干到一半，今天打开新会话，agent 一脸茫然——"我们昨天聊到哪了？"你只好翻聊天记录，重新交代一遍背景。

Work Continuity 把工作状态变成**不用你记得记**的事：目标、决策、下一步，工作自己留下痕迹；下次会话打开，agent 已经知道你在追什么。

## 三种捕获方式（v0.1.1+，2026-09-02/03）

早期版本只靠人敲 `/checkpoint` 命令——审计发现**装了一周只有 1 次冒烟写入**：功能不坏，是"要人记得敲命令"这件事本身不成立。现在有三层，互相兜底：

| 层 | 机制 | 覆盖的场景 |
|---|---|---|
| **事件自动捕获** | 监听宿主权威事件 `goal/change`（目标域每次变更必发）与 `todo/write`（任务清单每次写入必发） | agent 建了多步任务清单（≥2 项未完成）、用户设立/变更长期目标、目标完成/暂停/阻塞 |
| **LLM 自主决断** | 注册 `work_state` 模型工具 + 每轮注入当前工作摘要 | 对话里自然语言提出的构想、值得追踪的节点——LLM 看见摘要、自己决定记什么 |
| **显式命令** | `/checkpoint`（人随时可查可改） | 你想亲自盯着记的内容 |

- goal/change 事件会**建档/更新**目标与状态（complete→done、pause→paused…，clear 清空）；
- todo/write 事件只在**该工作区还没有任何 WorkState** 时自动建档（nextSteps 取自未完成任务）——已有手记内容不被每轮全量替换的 todo 覆盖；
- 每轮 pre-step 注入紧凑摘要（goal/status/focus/下一步，~150 token），LLM 由此知道"正在追踪什么"，在节点主动用 `work_state` 工具更新；无状态或已完成（done）不注入。

> 小故事：昨天你说"想给工具箱加个 FFT 工具"就睡了。当时 agent 顺手把这个构想记进了 next steps。今天新会话一开，agent 第一眼就看到 `[work-state] goal: 电子工具箱…`——不用你重复半句，直接接着昨天的话往下干。

## 一个简单的例子

昨天你加班到半夜，临走前对 agent 说：

> 记住，下一步是把测试跑通。

它记下了。今天早上你打开电脑，敲一句：

> /checkpoint show

目标、当时做的决策、下一步该干什么，全部列出来。你不用回忆，它也不用道歉。

## 命令

| 命令 | 说明 | 示例 |
|---|---|---|
| `/checkpoint goal <内容>` | 设置当前目标 | `/checkpoint goal 完成 M3 开发` |
| `/checkpoint decision <内容>` | 记录一个决策 | `/checkpoint decision 用 MIT 许可` |
| `/checkpoint next <内容>` | 添加下一步行动 | `/checkpoint next 合流组A` |
| `/checkpoint artifact <路径>` | 记录产物路径 | `/checkpoint artifact D:/out/report.pdf` |
| `/checkpoint unresolved <内容>` | 记录没解决的问题 | `/checkpoint unresolved 审批面板没显示` |
| `/checkpoint status <状态>` | 更新进度状态 | `/checkpoint status active`（planned/active/blocked/paused/done） |
| `/checkpoint focus <内容>` | 设置当前焦点 | `/checkpoint focus 修回归` |
| `/checkpoint show` | 查看当前工作状态 | `/checkpoint show` |
| `/checkpoint clear` | 清空 | `/checkpoint clear` |

### work_state 模型工具（LLM 侧，同数据）

模型可见工具 `work_state` 与 `/checkpoint` 共享同一 store/渲染/审计：action 支持 goal/decision/next/artifact/unresolved/focus/status/done/show/clear。工具描述明确告诉模型：用户提出新构想/目标、工作到值得追踪的节点、需要跨会话记住进度时调用；琐碎单步不要记。

## 设计取舍

**人可核对是底线**：无论哪层捕获，写进 work.db 的每一条都可以 `/checkpoint show` 查、`work_audit` 审计回溯，绝不做不可见的"每轮 LLM 总结"。

演进路径：MVP 只做显式命令（`/checkpoint`）→ 发现没人记得敲 → 加事件自动捕获（goal/change、todo/write，**确定性触发、无 LLM 猜测**）→ 再补 LLM 自主决断（`work_state` 工具 + 摘要注入，覆盖自然语言构想）。

噪声控制：已有 WorkState 不被 todo 全量替换覆盖；done 状态不注入；内容无变化不写库（diff 门控）；全部 fail-open——插件任何异常只记日志，绝不阻断对话。

## Agent 安装指南（面向自动化装配）

> 给需要在本机 dsh 装配本插件的 agent/脚本读；人工安装见下一节。
> 硬约束：① workDir 必须显式配置；② pnpm install 前先停 dsh（Windows native DLL 锁）；
> ③ 同 id 的 patch 条目是整体覆盖，不要重复插。

**1. 定位 profile**：`<DSH_HOME>/profiles/<profile>/`；先读 `package.json`，无
`dsh.profile.bundles` 键则 profile 未初始化，先初始化再继续。

**2. 添加依赖**（二选一）：

```bash
# A. GitHub 源：CLI 自动把声明 dsh.bundle 的包加入 dsh.profile.bundles
dsh plugin --profile <profile> add github:Icstick/dsh-work-continuity
# B. 本地开发：profile package.json dependencies 加 "dsh-work-continuity": "link:<绝对路径>",
#    并在同文件 dsh.profile.bundles 数组追加 "dsh-work-continuity"
```

⚠️ `dsh plugin add` 不会写配置条目——第 3 步必须做。

**3. 写配置**：编辑 profile 根 `cordis.patch.yml`（无则新建）：

```yaml
- id: work-continuity
  name: dsh-work-continuity
  config:
    workDir: C:\path\to\work-state   # 必填：工作状态库绝对路径；DSH_HOME 环境变量不可靠
```

**4. 安装并重启**：停 dsh → profile 目录 `pnpm install` → 重启 dsh。

**5. 验证**：
- 数据：`<workDir>/work.db` 存在
- 命令：对话里 `/checkpoint show` 正常响应（无状态时也应有明确空态提示）

**故障速查**：/checkpoint 不存在 → commands 服务加载晚于插件就绪属正常时序，插件会
等待注册；数据落在意外位置 → workDir 没显式配置（务必补）。

## 安装
> **GitHub 一键安装**：`dsh plugin --profile <name> add github:Icstick/dsh-work-continuity`
> （bundle patch 会自动挂载 work-continuity 条目）。装完后仍需在 profile 的
> cordis.patch.yml 给该条目补 `config.workDir`（数据目录必须显式）并重启；
> 完整三步与字段说明见下。


三步（和 dsh-adaptive-context 一样）：

**1. profile package.json**：

```json
{
  "dependencies": {
    "dsh-work-continuity": "link:D:/path/to/dsh-work-continuity"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-work-continuity"]
    }
  }
}
```

**2. profile cordis.patch.yml**：

```yaml
- id: work-continuity
  name: dsh-work-continuity
  config:
    workDir: C:\path\to\work-state   # 必须显式写
```

**3. 安装并重启**：

```bash
cd <profile 目录>
pnpm install
# 重启 dsh
```

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workDir` | string | **必填** | 工作状态数据目录（work.db 所在）。必须显式指定，DSH_HOME 环境变量不可靠 |
| `debug` | boolean | false | 调试日志 |

## 数据位置

- `workDir/work.db`（SQLite 单文件）——全部工作状态
- **数据是你的**：卸载不删；装回来即恢复

## 卸载

1. 从 package.json dependencies 移除 dsh-work-continuity
2. 从 dsh.profile.bundles 移除包名
3. pnpm install 后重启

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| /checkpoint 命令不存在 | commands 服务随 bundle 加载顺序可能晚于插件就绪——插件会等它出现再注册；还不行就检查 bundle 挂载 |
| 数据落在意外位置 | workDir 没显式配置（默认回退 DSH_HOME，环境变量不可靠）——务必显式配置 |

## 开发

```bash
node test/work.test.mjs
```

## License 与致谢

MIT License。参考项目致谢见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。

## 设置页配置卡片（v0.1.1+）

- 位置：DSH Web **设置 → 插件 → 插件配置**（`work-continuity` 卡片）
- 机制：host 侧注册 settings namespace（`work-continuity`），client bundle（`lib/client.js`，
  由 `node scripts/build-client.mjs` 生成）注册设置卡片；保存写入 settings.yaml
- 生效语义：**保存后重启生效**（apply 时 settings 值覆盖 cordis Config）
- 字段：workDir（重启生效）/ debug
