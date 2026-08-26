# dsh-work-continuity

DeepSeek Harness (dsh) 的 **Work Continuity** 插件——跨会话工作状态显式持久化，与通用记忆解耦。

## 命令

```text
/checkpoint goal <text>          设置当前目标
/checkpoint decision <text>      记录一个决策
/checkpoint next <text>          添加下一步行动
/checkpoint artifact <path>      记录产物路径
/checkpoint unresolved <text>    记录未解决问题
/checkpoint status <planned|active|blocked|paused|done>
/checkpoint focus <text>         设置当前焦点
/checkpoint show                 查看当前 WorkState
/checkpoint clear                清空
```

## 设计

WorkState 与 User Memory 分库逻辑分离（ACP 设计铁律：Memory does not own work continuity）。
MVP 为显式命令持久化（human-checkable），不做每 turn LLM 总结。

## 配置（Schemastery schema）

```yaml
- id: work-continuity
  config:
    workDir: C:\\path\\to\\work-state   # 显式路径
    debug: false
```

## 开发

```bash
node test/work.test.mjs
```

License: Apache-2.0
