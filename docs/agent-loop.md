---
title: 智能体闭环：Goal / Step / Action / Memory
description: 目标拆解、自定计划、自我修正与长期记忆的实现边界与不变量
date: 2026-11-18
tags:
  - 设计
  - 智能体
---

# 智能体闭环：Goal / Step / Action / Memory

本文描述 v1.2 新增的一层：让 `bkagent` 从「工具调用型」走到严格定义下的智能体——自主拆解目标、自定计划、自我修正、长期记忆——同时不把裁决权从确定性核心移走。版本记录见 `docs/plan-v1.1.md` 变更记录与 §20.1。

## 1. 为什么要这一层

此前的形态是：dsh 宿主提供循环与模型，`@backup-agent/dsh-plugin` 提供 8 个类型化工具，`bkagent` 提供确定性执行。这套组合在功能上算智能体，但缺四件事：

| 缺什么 | 后果 |
|---|---|
| 目标不是持久对象 | 一次会话结束，意图与进度一起消失 |
| 计划只在模型的上下文里 | 无法审计「它为什么这么排」，也无法在两次运行之间续上 |
| 失败只有分类，没有下一步 | `manual` 直接转人工，`permanent` 无人负责改计划 |
| 结果不回流 | 同一个签名在同一个目标上重复失败，系统不记得 |

这一层把四件事都做成控制库里的持久对象，并让模型在其中只承担它该承担的部分。

## 2. 四层结构

```
Goal        目标：操作者的原话 + 约束（步数、尝试预算、是否允许破坏性）
  └─ Step   拆解：序号、意图、动作、依赖、状态、尝试次数
       └─ Action   计划：命令 + 参数（受 capability grammar 约束）
            └─ Plan IR   执行：由既有 engine builder 生成，validatePlan 校验，executor 执行
```

关键点：**Action 不是 argv 的自由拼装，而是产品自身动词的受控组合**。模型说「对 app 库做一次 custom 格式备份」，落到 `{command:'backup', args:['--dsn',…,'--out',…,'--format','custom']}`；argv 的最终形态仍由控制面拼装，`--yes`、`--db`、`--principal` 由核心决定，模型无权设置。

## 3. 不变量

1. **核心不发明步骤。** 拆解来自模型；核心只校验（步数上限、序号唯一、依赖只能指向更早的步骤、动作通过 grammar、破坏性动作需目标级 `allowDestructive`）。依赖只能指向更早步骤，图因此天然无环。
2. **授权不随计划走。** 破坏性动作要求该 step 上有一个人工 `approver`；`goal run` 只在审批存在时才追加 `--yes`，并且内层命令仍要过 `destructive-gate`（Asset 登记、身份证明、生产环境双人复核）。两把锁，缺一不可。
3. **审批失败永不产生 `replan`。** `approval:required` 的诊断候选集只有 `escalate`。否则「自我修正」就变成绕过 four-eyes 换一个破坏性动作。
4. **封闭集。** `diagnose()` 返回候选集，`decideRemediation()` 拒绝集合外的选择。模型可以改主意，不能改规则。
5. **凭据不进动作，也不入库。** capability grammar 直接拒绝携带口令的 `--dsn`：动作会被持久化并在之后重放，而重放读到的是控制库里的那一份，所以口令必须走 `BKAGENT_DSN` / `.pgpass` / peer / GSSAPI。`redactAction()` 作为第二道防线保留，覆盖其它形如凭据的值。
6. **失败关闭。** 依赖 id 不存在、动作不合法、目标状态不允许迁移，一律拒绝而不是降级。
7. **下一步提示由核心计算。** `hint`（`run_step` / `remediate` / `await_approval` / `done`）由目标与步骤状态现算，不入库；模型只能在这个封闭集内行动，`await_approval` 是硬约束，其余为提示。详见 §9.3。

## 4. 数据模型（migration `012_goals.sql`）

| 表 | 作用 | 谁写 |
|---|---|---|
| `goals` | 目标：intent、约束、状态 | `goal add` |
| `goal_steps` | 拆解：序号、意图、动作、依赖、状态、尝试次数、审批人 | `goal plan` / `goal run` / `goal remediate` |
| `step_attempts` | 每次派发：退出码、错误类、失败签名、诊断（含候选集） | `goal run` |
| `memory_entries` | 长期记忆：目标、签名、动作、结果、成功与否 | `goal run` / `goal remediate` |

状态机在 `packages/core/src/domain/goal.ts`：目标 `open → planned → running → succeeded|failed|abandoned`（`running`/`failed` 可回到 `planned`，因为 replan 是合法的自我修正）；步骤 `pending → ready → running → succeeded|failed`，`abandoned` 是放弃终态（可从 `pending` / `ready` / `running` / `failed` / `blocked` 到达），`failed` 与 `blocked` 可回到 `ready`（重试或 replan 之后），`ready → pending` 用于 replan 重置，`pending → blocked` 表示依赖已失败。

## 5. CLI

```
bkagent goal add --db <path> --target <id> --intent <text>
                 [--steps-json <json> | --steps-file <path>]
                 [--constraints-json <json> | --constraints-file <path>]
                 [--principal <id>]
bkagent goal plan --db <path> --goal <id> [--steps-json <json> | --steps-file <path>]
bkagent goal next --db <path> --goal <id>
bkagent goal run --db <path> --goal <id>
bkagent goal show --db <path> --goal <id>
bkagent goal list --db <path> [--state <s>] [--target <id>] [--limit N]
bkagent goal approve-step --db <path> --step <id> --approver <id> [--reason <text>]
bkagent goal diagnose --db <path> --step <id>
bkagent goal remediate --db <path> --step <id> --kind retry|replan|escalate|abandon
                       [--action-json <json> | --action-file <path>] [--reason <text>]
bkagent memory search --db <path> [--target <id>] [--signature <s>] [--query <text>] [--limit N]
```

全部命令默认输出 JSON，`--format text` 输出可读行；退出码 `0` 成功、`1` 目标/步骤失败或需要审批、`2` 用法、`4` 拆解被拒 / 修复被拒 / 对象不存在。`goal run` 与 `goal remediate` 的载荷带 `hint`，见 §9.3。

`goal add --steps-json` 与 `goal plan --steps-json` 接受模型给出的拆解，校验后持久化，并返回**可运行顺序与相关记忆**——记忆在这里第一次真正参与规划，而不是事后查日志。

`goal run` 循环执行可运行步骤：取 `nextRunnable` → 拼 argv → 调用同一条 CLI 入口（因此过同一个 gate、同一个租约、同一次 run-lifecycle 落库）→ 记录 `step_attempt` → 诊断。`transient` 且在预算内时自动重试（确定性，不需要模型）；其余情况停下并返回诊断与候选集。

## 6. 自我修正闭环

```
失败 → classifyStepFailure（错误类 + 稳定签名）
     → diagnose（封闭候选集）
     → 自动：仅 retry
     → 需要新计划：replan（必须给出通过 grammar 的新动作）
     → 需要人：escalate / abandon
```

失败签名来自 `executor/classify.ts`，与 `failure-catalog.md` §9 同源，且是**稳定字符串**（`auth:password`、`sqlstate:42P01`、`connect:refused`…），因为记忆以它为键。改动签名等于改动记忆格式。

分类以控制面的结论为准：内层命令的 JSON 信封里有 `result.errorClass` 与该步真实的 stderr，`goal run` 直接采用；只有在信封不可解析时才退回按退出码推断。否则 `exit:1` 会把 `database "x" does not exist` 这类可修正的 permanent 失败抹平成无签名失败，而 `exit:3` 会把认证失败误判为可重试。

`replan` 是原地修订：替换该 step 的动作，保留历史尝试与尝试预算。不做 DAG 重连——那会让「修正」变成「重写历史」。

崩溃恢复：`goal run` 开始时若发现某个 step 仍停在 `running`，说明上一次运行没有走到终态。该 step 以签名 `stalled` 记为一次失败尝试（`permanent`，候选 `replan` / `escalate`），本次不再派发，目标随之落到 `failed`，由人或模型决定下一步。宁可让人重新决策，也不猜一个结果未知的副作用是否已经发生。

## 7. 长期记忆

写入是确定性的：每个终态步骤追加一条 `outcome`，escalate 时追加一条 `lesson`。读取是确定性的 `recall()`：签名精确匹配 +5、同目标 +3、文本重合 +1（上限 +3）、成功先例 +1，按分数、时间、id 三级排序。没有向量检索，没有模型参与——同一份记忆得到同一份上下文。

记忆通过两条路径影响下一次规划：`goal plan` 的返回值带 `prior`；`bk_recall` 工具让模型在拆解前主动查询。

## 8. 与既有机制的关系

- **Plan IR 不变。** 动作仍由 engine builder 生成 Plan，`validatePlan` / `preparePlan` / `fingerprint` 全部照旧。
- **破坏性门禁不变。** `DESTRUCTIVE_PLAN_COMMANDS` 未扩表：`goal run` 不是新的执行入口，它调用既有命令，因此走既有门禁。
- **租约与 fencing 不变。** 每个步骤各自取租约，步骤之间不持有长事务。
- **Outbox 不变。** 每次内层运行仍写 `audit.run`；目标层只额外写自己的四张表。

## 9. 智能体等级与判定

### 9.1 判定尺子

| 等级 | 判据 |
|---|---|
| L0 工具调用 | 模型选择工具，流程由人给定；没有持久目标，会话结束即丢失意图 |
| L1 受监督闭环 | 持久目标、自定计划、失败诊断与修复选择、结果回流记忆；破坏性动作的授权点由人掌握 |
| L2 自主 | 自触发、自愈、无人工授权路径，可无人值守运行到终态 |

本项目声称的等级是 **L1**，且对外必须写作「受监督智能体」。理由不是措辞偏好：破坏性步骤的 CLI 外审批是 L1 的构成要件（§3 第 2–3 条），而 `approval:required` 的诊断候选集只有 `escalate`，因此这条闭环在结构上不存在绕过授权的修复路径。据此，`自主智能体`、`无人值守` 不适用于本项目，文档与对外描述均不得使用。

判定对象是系统整体：dsh 宿主（循环与模型）+ `@backup-agent/dsh-plugin`（工具面）+ `@backup-agent/core`（裁决与执行）。`bkagent` 单独运行是确定性执行器，不是智能体；把二进制本身称为智能体属于错误表述。

### 9.2 四条判据与当前证据

| 判据 | 实现与证据 | 缺口 |
|---|---|---|
| 目标持久化 | migration `012_goals.sql` 四张表；`goal add` 写入意图与约束 | — |
| 自定计划 | `validateDecomposition` 校验模型给出的拆解，核心不发明步骤；`nextRunnable` 决定可运行顺序 | 依赖只能指向更早步骤，属顺序图而非自由 DAG |
| 失败诊断与修复选择 | `diagnose` 生成封闭候选集，`decideRemediation` 拒绝集合外的选择，`autoRemediation` 只放行 `retry` | — |
| 结果回流记忆 | 每个终态步骤写 `memory_entries`，`recall()` 确定性检索，`goal plan` 返回 `prior` | 无向量检索与语义聚类 |

模型侧行为的证据：`packages/dsh-plugin/test/goal-replay.test.js` 以固定决策序列经工具面驱动真实子进程、真实控制库与真实 PostgreSQL，覆盖成功、`permanent` 失败后 `replan`、未审批破坏性步骤三类路径并断言 `hint`。该用例验证的是闭环契约与工具面，**不验证模型是否会做出这些决策**；后者由 `scripts/e2e-agent.mjs` 的真实模型运行补充，2026-11-18 一次记录证明模型会开启目标并推进到 `hint: done`，失败与审批路径仍无模型证据。

### 9.3 next 与 hint

`next` 是调度器的结论：当前是否可派发步骤（`run` / `blocked` / `done` / `empty` / `waiting`）。它不适合单独作为智能体的下一步依据，因为它无法表达「失败步骤等待修复」与「破坏性步骤等待审批」。`hint` 补齐这个判断，取值封闭为四个：

| hint | 条件 | 允许的动作 |
|---|---|---|
| `run_step` | 存在可运行且无需审批的步骤 | 再次 `bk_step_run` |
| `remediate` | 存在 `failed` 步骤且候选集开放 | `bk_remediate`，只能选候选集内的处置 |
| `await_approval` | 下一个可运行步骤是未审批的破坏性动作 | 请人在 CLI 执行 `goal approve-step`；不得改用其它动作绕行 |
| `done` | 目标处于 `succeeded` / `failed` / `abandoned`，或已无动作可做 | 停止并汇总 |

优先级见 `packages/core/src/ops/goal-plan.ts` 的 `agentHint`：目标终态优先于一切，`remediate` 优先于 `await_approval` 与 `run_step`，其余按调度器结论。`hint` 由持久状态现算，不入库，因此不会与步骤状态不一致。`failed` 目标也返回 `done`：`escalate` 之后的决定属于人，继续提示修复会把「转人工」降级为建议。

### 9.4 工具面的失败载荷

`goal run` 与 `goal remediate` 在失败与被拒时仍向 stdout 写入决定（诊断与候选集、`refused` 原因），并以非零码退出。工具解析器原先在非零退出时丢弃 stdout，等于把候选集换成一句错误文本；因此这两个定义标注 `tolerateFailure`，解析器保留载荷并附加 `exitCode`。其余工具维持「非零即异常」。

### 9.5 证据与指标

- 准入检查：`pnpm test` 内的决策层回放，要求先执行 `pnpm build:cli`，并需要本地 PostgreSQL。前置条件缺失时用例以 SKIP 报告，不计为 PASS。
- 发版前：真实模型经 `dsh headless --json` 运行，断言 `tool_call` 序列与 `hint`；使用独立 `DSH_HOME`，不改动 `~/.dsh`。harness 与一次成功记录见 [`e2e-agent.md`](e2e-agent.md)；本仓库没有 CI，该步仍需人工执行。
- 自主完成率：分母为进入 `planned` 的目标，分子为未经人工 `remediate` / `escalate` 即到达 `succeeded` 的目标。样本少于 30 条时只报绝对条数与失败归因，不报百分比。

## 10. v1 边界

未做，且不应被描述为已实现：

- 多智能体协作与协商；
- 记忆的向量检索或语义聚类；
- 自由 DAG 重写（`replan` 只原地替换动作）；
- 目标级并发（同一目标串行执行）；
- E-09 真实模型 E2E 仍未进入发布准入检查。决策层回放已进入 `pnpm test`（§9.5），但「模型是否按契约决策」仍无回归门禁——这是当前最大的缺口。
