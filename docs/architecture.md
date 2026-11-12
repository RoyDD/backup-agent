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

  DB[("SQLite 控制库<br/>Ticket · Mandate · Plan · Attempt · Artifact · Approval")]
  KDB[("var/knowledge.sqlite")]
  TARGET[("PostgreSQL / provider repository")]

  U --> DSH
  U --> CLI
  DSH --> TOOLS
  SKILLS --> TOOLS
  TOOLS --> KB
  KB -.-> KDB
  TOOLS --> PLAN
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

分层解耦：智能体层为轻量适配层（anti-corruption layer），仅承担协议转换与交互职责；业务语义与安全策略集中于核心库，确保交互式与无人值守两种场景行为一致。
