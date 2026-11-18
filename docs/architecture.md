# 架构与流程

本文件与 `docs/plan-v1.1.md` §3 同步；方案为事实源，本文件用于 Git 跟踪与快速导航。

## 1. 分层架构

```mermaid
flowchart TB
  subgraph Entry["入口"]
    U["用户 / 定时任务 / CI"]
    DSH["dsh web · pg-dba preset"]
    CLI["bkagent CLI"]
    DASH["dashboard（只读）"]
  end

  subgraph Agent["智能体适配层"]
    TOOLS["@backup-agent/dsh-plugin"]
    SKILLS["skills：pg-backup / pg-restore / pg-pitr / pg-verify / pg-troubleshoot / engine-extend"]
    KB["kb_search → SAG2 证据检索"]
    GOAL["goal / step / memory<br/>拆解 · 调度 · 诊断 · 记忆"]
  end

  subgraph Core["控制平面 @backup-agent/core"]
    PLAN["Plan IR · Step DAG · fingerprint"]
    GATE["validatePlan + preparePlan（重基 ≤2）"]
    APPROVE["风险分级 · approval · four-eyes"]
    RUN["runPlan · retry · checkpoint"]
    OUTBOX["Outbox · lease · fencing token"]
    VERIFY["V0–V3 校验"]
    OPS["保留 · 报表 · 指标 · 通知"]
  end

  subgraph Engine["引擎适配层"]
    PG["engine-postgres<br/>logical · physical · PITR · pgBackRest · WAL-G"]
  end

  subgraph Exec["执行与存储"]
    EXEC["executor：local / ssh / kubectl"]
    STORE["storage：fs / s3 / nfs"]
    NOTIFY["notifier：webhook / smtp"]
  end

  DB[("SQLite 控制库<br/>Ticket · Mandate · Plan · Attempt · Artifact · Approval<br/>Goal · Step · Memory")]
  KDB[("var/knowledge.sqlite")]
  TARGET[("PostgreSQL / provider repository")]

  U --> DSH
  U --> CLI
  DSH --> TOOLS
  SKILLS --> TOOLS
  TOOLS --> KB
  TOOLS --> GOAL
  GOAL --> DB
  KB -.-> KDB
  TOOLS --> PLAN
  GOAL --> PLAN
  CLI --> PLAN
  PLAN --> GATE
  GATE --> APPROVE
  APPROVE --> RUN
  RUN --> PG
  PG --> EXEC
  PG --> STORE
  RUN --> OUTBOX
  OUTBOX --> DB
  RUN --> VERIFY
  VERIFY --> DB
  DB --> OPS
  OPS --> NOTIFY
  EXEC --> TARGET
  STORE --> TARGET
  DASH --> DB
```

引擎与 provider 通过 §11 契约描述：`EngineDescriptor` / `ProviderDescriptor` 声明能力、版本区间与所需工具，`ProviderAdapter` 提供 `inspect / plan / preflight / backup / restore / verify / catalog / prune` 八个操作。注册表与 `bkagent providers` 的用法见 [provider-contract.md](provider-contract.md)。

## 1.1 执行、存储与通知

| 层 | 实现 | 状态 |
|---|---|---|
| `Executor` | `local`（本地 spawn，argv-only） | 已用于所有命令 |
| | `ssh`（`BatchMode=yes` + `StrictHostKeyChecking=yes`，`UserKnownHostsFile` 必填；远端 argv 以 POSIX 单引号作为**传输编码**，本地不拼 shell 串） | 已实现；`Plan.transport` 可选中，`bkagent exec --transport ssh … -- <argv>` 用于契约验证 |
| | `kubectl exec … -- <argv>`（argv 直传，无 shell 字符串） | 已实现；`bkagent exec --transport kubectl …` |
| `Storage` | `fs` / `nfs`（root 限定、原子 rename、key 越界拒绝） | 已实现（端口 + 单元测试） |
| | `s3`（手写 SigV4，path-style，`fetch` 注入） | 已实现（签名有 AWS 官方向量对照） |
| `Notifier` | webhook | 已用于 outbox 与 watchdog |
| | SMTP（`node:net`，AUTH PLAIN，点填充，头注入防护） | 已实现；**无 STARTTLS**，仅适用于回环/可信中继 |

传输由 `Plan.transport` 记录并在执行处选择（`local` / `ssh` / `kubectl`），全局 `--transport` 等标志统一解析后同时用于探测与执行。远端计划**不转发子进程环境变量**：带 env 的远端计划在执行前被拒绝，操作者需在目标机准备凭据（`.pgpass` / peer / GSSAPI）；DSN 中的密码不会转发。探测在远端模式下把连接参数（host/port/user/dbname）作为 argv 传给 `psql`，因此无需任何 env；计划步骤本来就把连接参数放在 argv 中，密码只可能来自目标机自己的凭据源。

artifact 可经 `Storage` 落库：`backup --storage-kind fs|nfs|s3 [--storage-root …]` 在计划成功后把产物写入配置的 Storage，行内记录 storage 位置与 sha256（上传失败则整次运行判失败，不写一个读不到的位置）；`artifact-upload` 用于既有行。远端计划的产物记录为 `<transport>:<path>`（例如 `ssh:dba@db1:/var/backups/x.dump`），表示字节在目标机、控制面不可读；此时配置 storage sink 会被拒绝。`storage-purge` / `storage-gc` 因此对 fs 与 s3 位置都成立。

尚未接线：目录形态产物（`pg_basebackup -Fp`、`pg_dump -Fd`）暂不支持上传；远端产物上传需先把字节拉回控制面；SMTP 无 TLS。

## 2. Plan/Apply 流程

```mermaid
flowchart TD
  A["用户请求 / 定时任务"] --> B["pg_inspect：版本 · 角色 · WAL · 磁盘"]
  B --> C["构建 Plan IR：Step DAG + fingerprint"]
  C --> D{"validatePlan"}
  D -->|"FINGERPRINT / 配置漂移"| E["preparePlan：刷新指纹并重基，≤2 次"]
  E --> D
  D -->|"SCHEMA / PERMISSION / RESOURCE / POLICY"| F["返回 issues / 转人工"]
  D -->|"通过"| G{"风险等级"}
  G -->|"read-only / reversible"| H["runPlan：argv-only 执行"]
  G -->|"destructive"| Q{"--yes / ctx.approval"}
  G -->|"production-destructive"| R{"双人复核：approve ≥ 2"}
  Q -->|"拒绝"| F
  R -->|"不足"| F
  Q -->|"批准"| H
  R -->|"通过"| H
  H --> I{"退出码 + 后置条件"}
  I -->|"transient"| J["按 retryOn 退避"]
  J --> H
  I -->|"permanent / manual"| K["记录审计并终止"]
  I -->|"成功"| L["产物落 storage 或 provider repo"]
  L --> M["Outbox：审计 · 通知 · 血缘"]
  K --> M
  M --> N["V0–V3 校验"]
  N --> O["Artifact + VRP 写入控制库"]
  O --> P["catalog / report / metrics / dashboard"]
```

### 2.1 CLI 破坏性授权门禁

`packages/cli/src/destructive-gate.ts` 是所有破坏性 CLI Plan 的集中门禁；所有逻辑 `restore`（输入可含任意 SQL）、`pitr`、`pgbackrest-restore`、`pgbackrest-expire`、`walg-restore`、`walg-prune` 在调用 `executePlan` 前都必须经过它。门禁失败关闭，依次要求：

1. `--yes` 显式确认；
2. 探测到的 `systemIdentifier` 非空，且与 Plan fingerprint 完全一致——无法证明目标身份时拒绝执行，不做回退；
3. 控制库（`--db` → `BKAGENT_DB` → `.bkagent/control.db`）中存在与 `plan.targetId` 精确匹配的 Asset，否则报出 targetId 与 `asset-set` 注册命令；
4. 命中生产环境 Asset 时升级为 `production-destructive`，要求两名不同审批人的当前审批（`protected` 只影响保留策略，不构成审批豁免）；审批绑定 `plan.fingerprint.configDigest`，按审批人取最新决定（后续 reject 覆盖先前 approve），执行主体自身的审批被排除。

执行前会再次探测并用最终 Plan 重新跑一遍门禁：逻辑恢复在 `preparePlan` 刷新时不再回填旧 `systemIdentifier`，无法证明身份即中止；PITR、pgBackRest、WAL-G 路径在执行器调用前重新探测，身份变化或不可得则不执行任何步骤。Asset 与审批决定还会在 `BEGIN IMMEDIATE` 的 run-start 事务中复核；门禁之后出现的 reject 或生产环境变更会回滚 lease/fence 与 run envelope，保证没有 argv 到达 executor。

审批记录自 migration `007_approval_history.sql` 起为 append-only；`four-eyes` 的身份来自 CLI 推导的 principal（`os:$USER` 或 `--principal`），仅用于防止误自审，不构成密码学身份证明。

### 2.2 CLI 单目标执行租约与 fencing

所有 `executePlan` 路径（`packages/cli/src/execute-plan.ts`）在执行前都要在控制库中取得 `plan.targetId` 的租约；未传 `--db` 时同样使用默认控制库（`BKAGENT_DB` → `.bkagent/control.db`），因此 `pgbackrest-backup`、`walg-backup` 也补齐了 `--db` 参数。

- **锁键就是 provider 特定的 `plan.targetId`**。同一 PostgreSQL 集群经由不同 provider 或不同 data directory 生成的 Plan 具有不同 `targetId`，彼此**不会**串行化；这里不是集群级互斥。
- 获取租约在 `Repository.transaction()`（SQLite `BEGIN IMMEDIATE`）内完成，跨进程的「读 fence → 递增 → 写入」因此是原子的。同一 owner 在租约未过期时也不能直接重新获取，只能 `renew`，否则会绕过 fence 递增。
- owner 每次调用都是 `<principal|cli>:<pid>:<random>`，不使用常量 `cli`，避免两次运行互相续租或释放。
- TTL 默认 60s，心跳间隔为 `TTL/3`；续租失败（token 不匹配、租约已过期、DB 异常）即中止 `AbortSignal`，runner 不再派发任何步骤并返回 `lease-lost`。租约过期后不会被 `renew` 复活。
- `finally` 中只释放 owner+token 匹配的那一行；心跳任务先结束再释放。子进程执行期间不持有任何长事务，控制库连接只用于心跳与终态写入。

**运行生命周期**（`packages/core/src/persistence/run-lifecycle.ts`，由 `executePlan` 统一调用，不在各命令里分别接线）：

- **start 先于副作用**：取得租约的同一个 `BEGIN IMMEDIATE` 事务内写入 Ticket（`in_progress`）、Mandate、Plan（`dispatched`）与 Attempt（`running`），使用 Plan 自带的 `ticketId`/`mandateId`（不再新建 ticket ID），Attempt 记录真实 `targetId`、owner 与 lease token，并追加 ticket→plan、plan→attempt 血缘与确定性的 `audit.run` start 事件。事务提交后才允许派发子进程；start 写不进去就不会派发任何子进程，租约已过期也不会开始运行。
- **终态与 Outbox 同事务**：普通成功/失败在一个短事务内重新校验 `currentFence` 与仍然存活的租约行（owner/token/`expiresAt > now`），更新 Attempt 终态与错误字段、Ticket 状态、按需插入 Artifact、追加 attempt→artifact 血缘，并追加确定性的 `audit.run` 事件；失败时再加一条 `notify.failure` 事件。事务不跨越任何外部工作。终态写不进去时命令以 `lease-lost` 非成功退出，绝不把未留痕的运行报告为成功。
- `lease-lost`、fence 被取代或租约已过期时**不写任何终态、不写 Outbox**，Attempt 保持 `running` 交给对账；对账只有在匹配的活租约不存在/已过期/被更高 token 取代时才将其标为 `stalled`，即使运行时间已超过最初租约 TTL。
- 未传 `--db` 时同样写解析后的控制库（`BKAGENT_DB` → `.bkagent/control.db`），所有 `executePlan` 路径一致；provider 管理的备份不伪造本地 artifact 路径。

**fencing 边界**：fence 保护的是控制库提交。被取代或已过期的 worker 整个终态事务回滚，即使过期租约尚未被新 owner 接管也不能写入；外部 PostgreSQL、`pgbackrest`、`wal-g` 进程只在租约丢失时通过 `AbortSignal` **尽力**终止，provider 侧没有 fencing，不能据此断言外部副作用已被阻断。

### 2.3 计划失败清理（cleanup）

`Plan.cleanup` 是可选的补偿步骤图（`packages/core/src/domain/plan.ts`），只有当主步骤图失败时才由 `runPlan` 执行。

- 只在**失败**时执行，成功不触发；租约在清理边界已丢失时不执行任何清理步骤，因为此时没有派发权限。
- 每个清理步骤尽力尝试，前一步失败不会阻断后续清理；前置条件不再成立（例如 `postmaster.pid` 已消失）时记为 `skipped`，因此重复执行是幂等的。
- 清理失败写入 `result.cleanupFailed`，**不替换**原始 `failedStep`/`error`；`audit.run` 事件同时记录 `cleanup` 与 `cleanupFailed`，CLI 另在 stderr 提示目标可能需要人工处理。
- 清理属于可执行内容，因此纳入 `PlanFingerprint` 与 `validatePlan`（独立 DAG、禁止与主图重名、禁止依赖主图步骤、argv 同样禁止 shell 元字符）。

PITR 使用该机制：`buildPitrRestorePlan` 始终附带 cleanup 图——`stop-instance-on-failure`（`pg_ctl stop -m fast`）与随后的 `clear-start-marker`。

- `pg_ctl start` 成功后才写入 `<data-dir>/.bkagent-pitr-started`，cleanup 的停止步骤以「标记 + `postmaster.pid` 同时存在」为前置条件（前者证明实例由本 Plan 启动，后者证明仍有进程可停）。因此清理**只会停止本 Plan 启动的实例**：若 `start-instance` 因数据目录已有服务而卡在前置条件（`postmaster.pid` 存在），标记并不存在，cleanup 会跳过，不会误停他人的实例。
- 停止后删除标记，避免复用同一数据目录的下一个实例被后续清理误停。
- 此前目标未达成时服务器会继续占用数据目录，导致重跑时 `pg_ctl start` 直接失败；现在失败后实例会被停止，修正参数后可直接重跑。若清理本身失败（`cleanupFailed`），CLI 会在 stderr 明确报告，需要人工停止实例后再重试。

### 2.4 Outbox 派发

`packages/core/src/persistence/outbox-dispatch.ts` + `bkagent outbox-dispatch --db … [--limit N] [--max-attempts N]` 是独立于执行的派发器（cron 示例见 `deploy/cron.example`），`executePlan` 内联派发是被禁止的。

- 认领（claim）在 `BEGIN IMMEDIATE` 内完成并递增每条记录的 `delivery_token`（migration `009_outbox_delivery.sql`），因此跨进程不会重复认领。
- 投递是**至少一次**，不承诺 exactly-once；`outbox_id` 与 idempotency key 在投递时附加到信封上供接收端去重，存储的 payload 保持不变以便审计/重放。
- 处理 `audit.run`（保留，不外发）与 `notify.failure`（webhook 地址只来自 `BKAGENT_WEBHOOK_URL`，不进入 argv、payload、日志）。未知 topic 直接 dead-letter。
- 处理器失败按有界指数退避重试，达到 `max-attempts` 后状态置为 `failed`；确认/重试时间在处理器返回之后采样，因此超出认领租约的投递不会被误确认，重试计划也以真实失败时间为起点。确认时必须匹配当前 `delivery_token` 与未过期认领租约，被回收的旧消费者不能覆盖新认领。`watchdog` 报告 pending/expired/dead-letter 计数；对账把 Attempt 标为 `stalled` 时在同一事务追加 `audit.run` 与 `notify.failure`，崩溃运行因此仍有持久审计记录。

## 3. dsh 调用时序

```mermaid
sequenceDiagram
  participant U as 用户
  participant A as pg-dba Agent
  participant P as dsh-plugin
  participant C as bkagent CLI
  participant K as SAG2 knowledge
  participant PG as PostgreSQL / provider

  U->>A: 自然语言请求
  A->>P: pg_inspect / pg_backup / pg_verify / kb_search
  alt 文档与排障问题
    P->>K: ask --json --k N
    K-->>P: passages（source#ordinal + heading）
    P-->>A: 证据（不生成结论）
  else 备份 / 恢复
    P->>C: 构造 argv（凭据仅走环境变量）
    C->>PG: psql / pg_dump / pg_basebackup / provider 命令
    PG-->>C: 退出码 + stderr
    C-->>P: JSON 结果
    P-->>A: 工具结果
  end
  A-->>U: 结论 + 引用 + 风险说明
```

分层解耦：智能体层为轻量适配层（anti-corruption layer），承担协议转换与交互职责，并持久化目标与拆解；业务语义与安全策略仍集中于核心库——拆解要经 `validateDecomposition`，动作要经 capability grammar，破坏性动作要经门禁与人工审批——确保交互式与无人值守两种场景行为一致。

## 4. Goal / Step / Action 层

前 3 节描述的是单次执行。多步任务由 `goal` 层承载：目标是持久对象，拆解是持久对象，失败诊断与长期记忆也持久化。细节见 [agent-loop.md](agent-loop.md)。

```mermaid
flowchart TD
  G["Goal：intent + 约束 + 状态"] --> S["goal_steps：序号 · 意图 · 动作 · 依赖"]
  S --> V{"validateDecomposition"}
  V -->|"步数 / 依赖 / grammar / 破坏性未开启"| X["issues → 4"]
  V -->|"通过"| N{"nextRunnable"}
  N -->|"blocked"| B["依赖已失败 → blocked"]
  N -->|"run"| D{"破坏性且未审批"}
  D -->|"是"| E["diagnose approval:required → 转人工"]
  D -->|"否"| R["actionArgv → 既有 CLI 入口"]
  R --> L["destructive-gate · lease · run-lifecycle"]
  L --> O{"退出码"}
  O -->|"0"| M["step_attempt + memory_entries"]
  O -->|"非 0"| Q["classifyStepFailure → diagnose"]
  Q -->|"retry 且在预算内"| N
  Q -->|"其余"| H["返回候选集，停止"]
```

三条约束使它不成为第二条执行路径：

1. `goal run` 不构造 Plan IR，也不直接调用 executor；它把动作拼成 argv 后回到 `runCli`，因此同一套门禁、租约、`run-lifecycle` 与 outbox 全部生效。
2. 破坏性动作的 `--yes` 只在该 step 有人工审批时由核心追加，模型无法设置；`approval:required` 的诊断候选集只有 `escalate`。
3. 动作只能由 `ACTION_FLAGS` 声明的 flag 组合而成，`--yes` / `--db` / `--principal` / `--transport` / `--state-dir` 一律保留给核心。


### 4.1 下一步提示与工具面

调度器的 `next` 只回答「当前是否可派发步骤」，无法表达「失败步骤等待修复」与「破坏性步骤等待审批」。因此 `goal run` 与 `goal remediate` 的载荷另带 `hint`，取值封闭为 `run_step` / `remediate` / `await_approval` / `done`，由目标与步骤状态现算、不入库，模型只能在该集合内行动。

工具面只有一份实现：`packages/dsh-plugin/tools.js` 持有定义与 `buildArgv`，`packages/dsh-plugin/runner.js` 负责 spawn、解析与定义到 handler 的投影，`index.js`（dsh 插件）、`mcp.js`（MCP stdio）与决策层回放用例（`packages/dsh-plugin/test/goal-replay.test.js`）共用它。`bk_step_run` 与 `bk_remediate` 标记 `tolerateFailure`：这两个动词在失败与被拒时仍把决定写入 stdout 并以非零码退出，解析器保留载荷并附加 `exitCode`，否则模型只拿到一个退出码而看不到候选集。

等级判定、四条判据的证据与准入检查的边界见 [agent-loop.md](agent-loop.md) §9。
