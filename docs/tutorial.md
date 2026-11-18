---
title: bkagent 使用教程
description: 从零执行「探测 → 登记 → 备份 → 校验 → 恢复 → 观测」完整闭环的实操教程
date: 2026-11-18
tags:
  - 教程
  - 运维
  - PostgreSQL
---

# bkagent 使用教程

本文以一个可复现的演示库为对象，按顺序执行 bkagent 的最小闭环：探测实例、登记资产、产出备份、校验恢复点、通过门禁恢复、查看台账与告警。每一步都给出实际执行的命令与真实输出，并说明这一步为什么必须存在。

适合两类读者：首次接触本项目、需要在本机完成端到端验证的 DBA；以及评估该链路是否满足生产要求的评审者。命令参数与门禁细则见 [usage.md](usage.md)（完整命令清单以 `bkagent --help` 为准），设计原理见 [architecture.md](architecture.md)；本教程只覆盖主线与常见分支。

源码仓库：[RoyDD/backup-agent](https://github.com/RoyDD/backup-agent)。本教程的 Markdown 源文件为 [`docs/tutorial.md`](https://github.com/RoyDD/backup-agent/blob/main/docs/tutorial.md)，单页版为 [`docs/tutorial.html`](https://github.com/RoyDD/backup-agent/blob/main/docs/tutorial.html)；文中提到的命令、脚本与插件均可在该仓库对应路径下查阅。

本教程的输出取自本地演练环境（PostgreSQL 16.15、控制库为临时目录下的 SQLite 文件），其中的 id、时间戳、大小与临时库名随环境变化，字段名与命令不变。截图里的产物路径位于演练临时目录，正文命令统一用 `/var/backups` 表示常规落地位置。

```mermaid
flowchart TD
  A["1. inspect<br/>确认实例身份"] --> B["2. asset-set<br/>登记目标资产"]
  B --> C["3. providers<br/>确认可用链路"]
  C --> D["4. backup<br/>产出恢复点"]
  D --> E["5. verify<br/>将 V1 升级为 V2"]
  E --> F["6. catalog 查看台账"]
  F --> G["7. restore<br/>过三重门禁"]
  G --> H["8. dashboard / watchdog<br/>观测与告警"]
```

## 1. 准备环境

### 1.1 安装与构建

```sh
pnpm install
pnpm build:cli                       # 产出 dist/bkagent.mjs 与 dist/migrations
```

开发态可改用 `pnpm bkagent <command>`，由 `tsx` 直接从源码执行，参数与构建产物完全一致。后文命令统一写作 `bkagent`，指二者之一。

环境要求：Node.js ≥ 22.5（依赖 `node:sqlite`，运行时的 `ExperimentalWarning: SQLite` 属预期）、pnpm 11.24、目标 PostgreSQL 14–17 且 `psql` / `pg_dump` 可用。

### 1.2 准备一个可备份的数据库

本文假定目标实例已有业务库；若不存在，可执行下列脚本创建 `bk_tut`（三张表、一个索引、200 条客户记录、800 条订单记录）。

```sh
createdb -h 127.0.0.1 -p 5432 -U postgres bk_tut
```

（下列命令以 5432 为例；本文截图取自 55416 的本地演练实例，端口按实际实例替换。）

```sql
CREATE TABLE customers (
  id bigserial PRIMARY KEY, email text NOT NULL UNIQUE,
  region text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  status text NOT NULL, total_cents bigint NOT NULL CHECK (total_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE TABLE order_items (
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku text NOT NULL, qty int NOT NULL CHECK (qty > 0), price_cents bigint NOT NULL,
  PRIMARY KEY (order_id, sku)
);
INSERT INTO customers (email, region)
SELECT 'user' || i || '@example.com', (ARRAY['apac','emea','amer'])[1 + i % 3]
FROM generate_series(1, 200) AS i;
INSERT INTO orders (customer_id, status, total_cents)
SELECT 1 + (i % 200), (ARRAY['paid','pending','refunded'])[1 + i % 3], 1000 + i * 7
FROM generate_series(1, 800) AS i;
INSERT INTO order_items (order_id, sku, qty, price_cents)
SELECT o.id, 'SKU-' || (1 + (o.id % 40)), 1 + (o.id % 3), 500 + o.id FROM orders AS o;
ANALYZE;
```

### 1.3 三个入口参数

| 变量 / 参数 | 缺省值 | 作用 |
|---|---|---|
| `--dsn` 或 `BKAGENT_DSN` | 无（必填） | 目标实例连接串，`postgres://<user>@<host>:<port>/<db>` |
| `--db` 或 `BKAGENT_DB` | `.bkagent/control.db` | 控制库路径，首次使用时自动执行迁移 |
| `BKAGENT_MIGRATIONS` | 包内 `dist/migrations` | 单文件安装时迁移目录缺失，会以 `no such table` 报错，用它指回迁移目录 |

密码不要写进 argv：用 `.pgpass`、peer 认证或 `PGPASSWORD` 环境变量。核心会把连接串里的密码放进子进程环境变量，不会写进 Plan、日志或指标标签。

### 1.4 一次操作在控制库里留下什么

```mermaid
flowchart LR
  CMD["一条命令"] --> T["Ticket<br/>意图"]
  T --> P["Plan<br/>Step DAG + 指纹"]
  P --> A["Attempt<br/>执行结果"]
  A --> AR["Artifact<br/>产物 + 校验等级"]
  P --> O["Outbox<br/>审计 / 通知"]
  AS["Asset<br/>目标业务属性"] --- AR
  AS --- AP["Approval<br/>绑定操作 digest"]
```

`inspect`、`providers` 不写控制库；`backup` 写 Plan/Attempt/Artifact；`verify` 把校验等级升级到 V2；`restore` 读 Asset 与 Approval 做门禁。v1.2 另增 `goals`、`goal_steps`、`step_attempts`、`memory_entries` 四张表承载智能体闭环，见 10.2。退出码含义：`0` 成功、`1` 执行失败、`2` 用法错误或门禁拒绝、`3` 连接失败、`4` plan/probe 失败。

## 2. 第 1 步：`inspect` —— 先确认在对谁操作

```sh
export BKAGENT_DSN='postgres://postgres@127.0.0.1:55416/bk_tut'
bkagent inspect --format text
```

![inspect 的实际输出](assets/tutorial/01-inspect.png)

下列字段的用途超出「确认版本」本身：

| 字段 | 为什么关心 |
|---|---|
| `version` / `server_version_num` | 决定可用的备份方式与参数，也用于判断目标是否在支持矩阵（14–17）内 |
| `system_identifier` | 实例身份。计划指纹绑定它，换实例（重建、主备切换）会让既有计划指纹失配 |
| `in_recovery` | 备库为 `true`；在备库上做物理备份与 PITR 的前提不同 |
| `wal_level` / `archive_mode` | 逻辑备份不需要；物理备份、PITR、WAL-G 链路分别要求 `replica`/`logical` 与开启归档 |
| `execution_site` | `local` 表示在本机 spawn；远端执行时显示 `ssh:` / `kubectl:` 前缀 |
| `databases` | 同实例的数据库清单；填写 `--database` 时须与库名一致 |

请全程统一写 `127.0.0.1`：接下来登记的资产 `targetId` 必须与计划算出的字符串完全一致，主机名写法不同会被识别为两个不同目标。

## 3. 第 2 步：`asset-set` —— 登记目标资产

资产（Asset）是目标的业务属性：环境、负责人、关键级别、数据分级、RPO、RTO。它不是可选的备注，而是三件事的输入：恢复门禁判断是否属于生产、`watchdog` 判断告警等级、`asset-rpo` 判断恢复点是否过期。

```sh
bkagent asset-set --target 127.0.0.1:55416/bk_tut --engine postgres \
  --environment production --owner dba --criticality high \
  --data-classification internal --rpo-minutes 1440 --rto-minutes 240
```

![asset-set 的输出](assets/tutorial/03-asset-set.png)

`targetId` 不是自由文本，由 `<host>:<port>/<database>` 三段拼成，必须与计划计算结果逐字符相同：

```mermaid
flowchart LR
  D["--dsn postgres://postgres@127.0.0.1:55416/bk_tut"] --> H["host = 127.0.0.1"]
  D --> P["port = 55416"]
  D --> B["database = bk_tut"]
  H --> T["targetId = 127.0.0.1:55416/bk_tut"]
  P --> T
  B --> T
  T --> G{"与 Asset 行匹配？"}
  G -->|"是"| OK["门禁放行"]
  G -->|"否"| NO["拒绝：no asset registered"]
```

三处常见错误：

- 用 `localhost` 登记、用 `127.0.0.1` 备份，会被识别为两个不同目标。
- 恢复时 `--database` 是**目标库名**，与备份来源库名不同，`targetId` 也随之改变；换库名恢复要为新库单独登记。
- 已存在的资产要「变宽松」（降低关键级别、去掉 `--protected`、改环境）时，必须再加 `--yes --principal <id>`，否则被拒。

## 4. 第 3 步：`providers` —— 确认可用链路

```sh
bkagent providers --format text
```

![providers 的实际输出，退出码 1](assets/tutorial/02-providers.png)

```text
native-logical: ok
native-physical: ok
pgbackrest: NOT READY — TOOL_MISSING(pgbackrest): required tool "pgbackrest" is not available or did not report a version
walg: NOT READY — TOOL_MISSING(wal-g): required tool "wal-g" is not available or did not report a version
```

这段输出需要正确解读，否则会误判为故障：

- 本机未安装 `pgbackrest` 与 `wal-g`，因此两条链路为 `NOT READY`，命令以退出码 `1` 结束。这是**能力协商（capability negotiation）失败关闭**：未声明的能力会明确报错，不会静默降级成 `pg_dump`。
- `native-logical`、`native-physical` 为 `ok`，只说明 `pg_dump` / `pg_basebackup` 可用，不代表版本匹配已通过；真正的版本与参数校验在执行时按计划逐步进行。
- 只关心逻辑备份时，这两行 `NOT READY` 可忽略；但只要计划里出现 `pgbackrest-*` / `walg-*` 步骤，就必须先让对应工具出现在 `PATH` 上（或显式传 `--walg <bin>`）。

## 5. 第 4 步：`backup` —— 产出第一个恢复点

```sh
bkagent backup --database bk_tut --out /var/backups/bk_tut.dump --format custom
```

![backup 的实际输出（节选）](assets/tutorial/04-backup.png)

```text
[dump] running
[verify-artifact] running
{
  "planId": "pln_73c9660e-7088-47ee-8273-228c4383bd4d",
  "risk": "read-only",
  "steps": ["dump", "verify-artifact"],
  "result": {
    "planId": "pln_73c9660e-7088-47ee-8273-228c4383bd4d",
    "status": "succeeded",
    ...
```

```mermaid
sequenceDiagram
  autonumber
  participant CLI as bkagent backup
  participant Core as 确定性核心
  participant PG as 目标 PostgreSQL
  participant DB as 控制库

  CLI->>PG: inspect（校验实例身份与版本）
  CLI->>Core: 构造并校验 Plan（argv-only）
  Core->>PG: pg_dump --format custom
  Core->>PG: pg_restore -l（列出 TOC，确认文件可解析）
  Core->>DB: Attempt / Artifact（V1）/ 审计 Outbox
```

要点：

- 一次逻辑备份是两个步骤：`dump` 与 `verify-artifact`。第二步用 `pg_restore -l` 读取目录（TOC），解析成功即说明归档文件完整，产物记为 **V1**（包含大小与 SHA256 摘要）。
- `risk` 是 `read-only`：备份不修改目标数据，因此不需要 `--yes`、不需要资产、不需要审批。
- 产物默认落在 `--out` 指定路径；`--storage-kind fs|nfs|s3` 可让核心上传后再登记，`--remove-local` 删除本地副本。凭据同样只走环境变量（`BKAGENT_S3_*`）。
- 常用变体：`--format directory --jobs 4`（并行、可按表恢复）、`--format plain`（纯 SQL，便于人工查看）、`--mode physical`（`pg_basebackup`，需要 `replication` 权限与 `wal_level=replica`）。

## 6. 第 5 步：`verify` —— 把 V1 升级为 V2

V1 仅证明归档文件可写出。要证明备份可恢复且数据一致，必须实际执行一次恢复：

```sh
bkagent verify --input /var/backups/bk_tut.dump --database bk_tut
```

![verify 的实际输出](assets/tutorial/05-verify.png)

```json
{
  "ok": true,
  "compared": true,
  "scratchDatabase": "bk_verify_mwlex2be_o6bw",
  "restoreExitCode": 0,
  "tables": [
    { "relation": "public.customers", "source": 200, "target": 200, "match": true },
    { "relation": "public.order_items", "source": 800, "target": 800, "match": true },
    { "relation": "public.orders", "source": 800, "target": 800, "match": true }
  ],
  "schema": { "compared": true, "differences": [] },
  "amcheck": { "available": true, "checked": 48, "failed": [], "reason": null },
  "warnings": []
}
```

```mermaid
flowchart TD
  A["verify --input dump"] --> B["创建临时库<br/>bk_verify_*"]
  B --> C["pg_restore 到临时库"]
  C --> D["逐表比对行数"]
  D --> E["比对列 / 约束 / 索引<br/>schema diff"]
  E --> F["amcheck 检查索引<br/>B-Tree 结构"]
  F --> G{"全部通过？"}
  G -->|"是"| H["Artifact 记为 V2<br/>临时库删除"]
  G -->|"否"| I["输出差异<br/>不写 V2"]
```

校验等级决定「该恢复点是否可用」：

| 等级 | 含义 | 写入者 |
|---|---|---|
| V0 | 产物存在且命令成功 | `backup`（物理备份的 `pg_verifybackup` 计划内校验） |
| V1 | 已记录大小与内容摘要 | `backup` |
| V2 | 恢复到临时库后比对行数、schema 与 `amcheck` | `verify` 实际执行通过 |
| V3 | 业务冒烟 SQL 断言 | 尚未实现（用例集缺失） |

等级不能靠声明获得：`artifact-add --verified-level V2` 必须同时给出 64 位十六进制 `--checksum`；`verify` 仅在完整执行比对后才写回 V2。`--keep-scratch` 保留临时库用于排查，默认删除。

## 7. 第 6 步：查看台账

```sh
bkagent catalog
bkagent asset-rpo
```

![catalog 与 asset-rpo 的实际输出](assets/tutorial/06-catalog.png)

```json
[
  {
    "id": "art_5ecceb0e-e4a7-4423-8d72-1d55c6e4bd0d",
    "targetId": "127.0.0.1:55416/bk_tut",
    "provider": "native-logical",
    "kind": "logical",
    "path": "/tmp/opencode/tutorial/run/bk_tut.dump",
    "sizeBytes": 18248,
    "checksum": "60d264f66d7ca4c6068b403df79de9857b39d2d4e3de45c298cda48c377ed29f",
    "verifiedLevel": "V2",
    "lifecycleState": "live",
    ...
  }
]
```

需要重点关注三个字段：`verifiedLevel`（V2 才有恢复价值）、`lifecycleState`（`live` / `tombstoned`，保留策略只打墓碑不删文件）、`checksum`（与远端存储副本比对时使用）。

`asset-rpo` 从另一个角度回答「当前是否存在满足 RPO 的恢复点」：`ageMinutes` 是最近一次 V2 的年龄，`withinRpo` 与资产登记的 `--rpo-minutes` 比较。巡检脚本通常直接读取这两个字段。

`report` 输出面向人的汇总，`metrics` 输出 Prometheus 文本格式的时间序列：

![report 与 metrics 的实际输出（metrics 为节选）](assets/tutorial/11-report-metrics.png)

一处容易误读的行为：被门禁拒绝的恢复同样写入一条 `Attempt`（错误类 `permanent`），因此 `report` 的失败率包含「门禁拒绝」。失败率高不代表备份异常，应先查看 `## Failures by class`。

## 8. 第 7 步：`restore` —— 三重门禁

逻辑恢复一律按破坏性操作处理：输入的 SQL 可能含 `DROP`，`--clean` 更会先清空目标库对象。门禁按顺序求值，任一条件不满足即拒绝，并打印下一条应执行的命令。

```mermaid
sequenceDiagram
  autonumber
  participant DBA as 执行者
  participant CLI as bkagent restore
  participant Core as 确定性核心
  participant DB as 控制库
  participant PG as 目标 PostgreSQL

  DBA->>CLI: restore --input … --database … [--yes]
  CLI->>Core: 校验 Plan 风险等级
  Core-->>DBA: 拒绝：destructive 计划需要 --yes
  Core->>DB: 查 targetId 对应的 Asset
  DB-->>Core: 缺失 → 拒绝（列出 asset-set 命令）
  Core->>DB: environment=production → 查 digest 绑定的审批
  DB-->>Core: distinct < 2 → 拒绝（打印 digest 与 approve 命令）
  Core->>PG: create-database → restore（argv-only）
  Core->>DB: Attempt / Artifact / 审计 Outbox（同一事务）
```

### 8.1 第 1 道：`--yes`

```sh
bkagent restore --dsn 'postgres://postgres@127.0.0.1:55416/postgres' \
  --input /var/backups/bk_tut.dump --database bk_tut_restore --create-database
```

```text
bkagent: plan risk is destructive for target "127.0.0.1:55416/bk_tut_restore"; re-run with --yes to proceed
```

计划本身声明了 `risk: destructive`，缺 `--yes` 直接拒绝。这一步不是提示语，是硬性检查：风险等级由 `DESTRUCTIVE_PLAN_COMMANDS` 决定，计划若低报风险会被判 `risk-understated` 并拒绝。

### 8.2 第 2 道：资产必须已登记

加上 `--yes` 后，`targetId` 变为 `127.0.0.1:55416/bk_tut_restore`；需注意该目标不是来源库 `bk_tut`：

```text
bkagent: no asset registered for target "127.0.0.1:55416/bk_tut_restore" in control database "/tmp/opencode/tutorial/run/control.db". Register it before destructive work:
  bkagent asset-set --db /tmp/opencode/tutorial/run/control.db --target 127.0.0.1:55416/bk_tut_restore --engine postgres --environment <production|staging|development|test> --owner <owner> --criticality <critical|high|medium|low> --data-classification <public|internal|confidential|restricted> --rpo-minutes <n> --rto-minutes <n> [--protected]
```

拒绝信息中包含修复命令，可直接复制执行。这里也是「环境」字段第一次产生实际后果的分岔点：登记为 `production` 会触发第 3 道门禁。

### 8.3 第 3 道：生产目标需要双人复核

按提示把 `bk_tut_restore` 登记为 `production` 后重试：

```sh
bkagent asset-set --target 127.0.0.1:55416/bk_tut_restore --engine postgres \
  --environment production --owner dba --criticality high \
  --data-classification internal --rpo-minutes 1440 --rto-minutes 240
```

```text
bkagent: production-destructive plan on target "127.0.0.1:55416/bk_tut_restore" requires 2 distinct approvals; have 0.
digest: d6861131af1c512044d482270cf24a78e26016de757577832632eaf486600e2a
approve: bkagent approve --db … --target 127.0.0.1:55416/bk_tut_restore --digest d686… --approver <id>
inspect: bkagent approvals --db … --target 127.0.0.1:55416/bk_tut_restore --digest d686…
```

三次拒绝均以退出码 `2` 结束，脚本可据此区分「门禁拒绝」与「执行失败」。

![三次拒绝的实际输出](assets/tutorial/07-restore-gates.png)

审批绑定的是 **digest**，不是目标名：digest 由操作内容（计划指纹、配置摘要）算出，改了输入文件或参数就要重新审批。审批窗口 60 分钟。

审批按**操作系统身份**去重，这是最常见的误解：

![approve 与 approvals 的实际输出](assets/tutorial/08-approvals.png)

```json
{
  "targetId": "127.0.0.1:55416/bk_tut_restore",
  "digest": "d6861131af1c512044d482270cf24a78e26016de757577832632eaf486600e2a",
  "status": { "required": 2, "distinct": 1, "ok": false, "reason": "insufficient-approvals" },
  "approvals": [
    { "approver": "alice", "approverOs": "os:roy", "decision": "approve" },
    { "approver": "bob",   "approverOs": "os:roy", "decision": "approve" }
  ]
}
```

两个标签、同一个 OS 用户，`distinct` 仍然是 `1`，门禁不放行；再次执行时连请求者自己的审批也会被忽略，并打印 `ignored self-approval from requester: bob`。要真正满足双人复核，必须由第二个操作系统用户执行 `approve`。

### 8.4 一次通过

非生产目标只需要 `--yes`。登记一个 `test` 环境的目标后重试：

```sh
bkagent asset-set --target 127.0.0.1:55416/bk_tut_copy --engine postgres \
  --environment test --owner dba --criticality medium \
  --data-classification internal --rpo-minutes 2880 --rto-minutes 480
bkagent restore --dsn 'postgres://postgres@127.0.0.1:55416/postgres' \
  --input /var/backups/bk_tut.dump --database bk_tut_copy --create-database --yes
```

![restore 成功与数据核对](assets/tutorial/09-restore-ok.png)

```text
[create-database] running
[restore] running
{
  "planId": "pln_22d0d6ff-e13d-41e3-9d5e-41fbc6bc29a0",
  "risk": "destructive",
  "steps": ["create-database", "restore"],
  "result": { "status": "succeeded", ... }
}
```

恢复命令成功不代表数据一致，需再核对行数：

```sh
psql -h 127.0.0.1 -p 55416 -U postgres -d bk_tut_copy \
  -c 'select (select count(*) from customers) as customers, (select count(*) from orders) as orders'
```

```text
 customers | orders
-----------+--------
       200 |    800
(1 row)
```

该人工核对与 `verify` 的职责重叠，但两者的校验对象不同：`verify` 校验的是**备份文件**能否恢复且一致，这一步校验的是**这次恢复操作**落到了正确的库。

拒绝信息与下一步，对照表：

| 现象 | 原因 | 下一步 |
|---|---|---|
| `plan risk is destructive … re-run with --yes` | 缺 `--yes` | 加 `--yes`，先确认目标库名 |
| `no asset registered for target …` | 目标未登记，或 `host`/`port`/库名不一致 | 按拒绝信息中的 `asset-set` 执行 |
| `requires 2 distinct approvals; have 0` | 生产目标，审批不足 | 按打印的 `digest` 让第二个 OS 用户 `approve` |
| `ignored self-approval from requester …` | 同一 OS 用户重复审批 | 换第二个操作系统用户 |
| `config drift` / 指纹失配 | 目标实例或配置在计划生成后发生变化 | 重新执行 `inspect` 确认身份，再重新发起 |

## 9. 观测：`dashboard` 与 `watchdog`

只读面板不连目标库，只读控制库：

```sh
bkagent dashboard --out /var/www/bkagent.html     # 生成自包含 HTML
bkagent dashboard --serve --port 8787             # 只绑定 127.0.0.1
```

![dashboard 的实际界面](assets/tutorial/10-dashboard.png)

面板内容全部来自控制库，字段经 HTML 转义；`--serve` 仅绑定 `127.0.0.1`，要对外开放请自行套反向代理并加认证。

告警走 `watchdog`，按 P1–P4 阶梯评估，先做一次对账（启动时残留的 `running` 会被判 `stalled`）：

```sh
bkagent watchdog
```

![watchdog 的实际输出（节选）](assets/tutorial/12-watchdog.png)

上述两条 P1 告警的成因是：`bk_tut_restore` 与 `bk_tut_copy` 被登记为**需备份的资产**，但没有 V2 产物，因此判定为 `no-vrp`。由此得到的约束是：恢复用的临时目标不应登记为长期资产，否则该目标会进入 RPO 统计范围。常规巡检中，`watchdog` 的输出可接入 `BKAGENT_WEBHOOK_URL` / SMTP；投递失败会留在 Outbox 中，用 `outbox-dispatch` 重投。

## 10. 进阶：三条继续往前的路

主线验证通过后，按目标从下列三条路径中选择一条继续，无需逐条阅读完整命令清单。

```mermaid
flowchart TD
  M["主线已验证"] --> A["A. 目标在别的机器<br/>或容器里"]
  M --> B["B. 需要增量 / PITR<br/>或已有备份仓库"]
  M --> C["C. 由智能体执行操作"]

  A --> A1["--transport ssh / kubectl"]
  A --> A2["前置：目标机预置凭据<br/>known_hosts"]
  B --> B1["pgBackRest / WAL-G 编排"]
  B --> B2["前置：工具在 PATH<br/>仓库归 provider"]
  C --> C1["dsh 插件 + pg-dba preset"]
  C --> C2["bkagent-mcp（MCP 服务）"]
```

| 路线 | 入口 | 必须先满足 | 本教程状态 |
|---|---|---|---|
| 远端执行 | 目标类命令加 `--transport ssh` 或 `--transport kubectl` | `--ssh-host` + `--known-hosts`（强制 `BatchMode=yes`、`StrictHostKeyChecking=yes`），或 `--kubectl-pod`；凭据预置在目标机 | 未在本教程演示 |
| provider 链路 | `pgbackrest-backup\|restore\|expire`、`walg-backup\|restore\|prune` | 对应工具在 `PATH` 上且版本可探测 | 未演示，本机 `providers` 报 `TOOL_MISSING` |
| 智能体面 | `packages/dsh-plugin`、`presets/pg-dba/`、`bkagent-mcp` | `pnpm build:cli` 产出 `dist/bkagent.mjs`；安装脚本 `scripts/install-dsh.sh` | 已安装并通过预设加载验证（见 10.1） |

三条共同的硬约束：

- 远端传输**不转发环境变量**：带 env 的计划在执行前被拒绝，密码必须由目标机的 `.pgpass` / peer / GSSAPI 提供。
- 远端产物的路径记为 `<transport>:<path>`，表示字节位于目标机、控制面无法读取，因此 `verify --input` 不能直接使用该路径。
- provider 的备份仓库归 provider 所有，保留操作仅能通过 `pgbackrest expire` / `wal-g delete retain` 执行；bkagent 只做编排与台账。
- MCP 模式下破坏性工具失败关闭，默认不会因「智能体要求」而绕过门禁。

### 10.1 把 bkagent 装成 dsh 插件

dsh 0.2.x 改了两处与本项目相关的机制：profile 由「有序的 bundle patch 层」组合，`dsh plugin add` 只负责把包装进 profile；预设不再是 `$DSH_HOME/.agent-presets/` 下的目录，而是 bundle patch 里的一条 `@deepseek-ai/dsh-agent-preset` 行。仓库已经适配：[`packages/dsh-plugin/package.json`](https://github.com/RoyDD/backup-agent/blob/main/packages/dsh-plugin/package.json) 声明 `dsh.bundle`，[`packages/dsh-plugin/cordis.patch.yml`](https://github.com/RoyDD/backup-agent/blob/main/packages/dsh-plugin/cordis.patch.yml) 提供 `pg-dba` 预设。

```sh
dsh --version                       # 需要 0.2.x；本文验证于 0.2.2-rc.4
bash scripts/install-dsh.sh web     # 或指定其他 profile 名
```

脚本执行三个步骤：

1. `pnpm build:cli`、`pnpm build:knowledge` 产出两个单文件包；
2. `var/knowledge.sqlite` 不存在时重建知识索引；
3. `dsh plugin --profile web add link:<repo>/packages/dsh-plugin`；插件声明了 `dsh.bundle`，`add` 会同时把它写入 profile 的 bundle 列表。

预设随补丁层挂载，不再复制目录。

以下两项验证缺一不可：

```sh
dsh --profile web --dump-config | grep -A2 preset-pg-dba   # 补丁层是否生效
dsh --profile web --no-open                                # 设置 → Agent 预设
```

![dsh 设置页中的自定义预设](assets/tutorial/13-dsh-preset.jpg)

设置页出现「自定义 / PostgreSQL 备份恢复」，且没有「加载失败」，说明预设内每一行（persona、`@backup-agent/dsh-plugin`、技能目录）都已激活；此后新建会话并选用该预设，即可使用 `pg_inspect`、`pg_backup`、`pg_restore`、`pg_pitr`、`pg_verify`、`pg_catalog`、`pg_report` 与 `kb_search`，以及闭环工具 `bk_goal`、`bk_step_run`、`bk_remediate`、`bk_recall`。

安装过程中实际遇到的三处问题：

| 现象 | 原因 | 处理 |
|---|---|---|
| 安装完成后插件页出现 `@backup-agent/dsh-plugin`，但预设列表中不存在该预设 | 包未声明 `dsh.bundle`，`add` 只将其作为普通依赖 | 在 `package.json` 增加 `dsh.bundle.patch`，先 `remove` 再 `add` |
| 预设显示「加载失败」，提示 `$.prefix missing required value` | 0.2.x 的 persona 行要求 `prefix`，0.1.x 的 `text` 不再接受 | 改写为 `prefix`；`{{…}}` 变量必须是已注册的，否则同样报错 |
| 手工把预设目录复制到 `~/.dsh/.agent-presets/` 无效 | 0.2.x 不再读取该目录 | 改为 bundle patch 的 `@deepseek-ai/dsh-agent-preset` 行 |

不使用 dsh 时，可继续使用 MCP 入口：

```sh
BKAGENT_CLI=$PWD/dist/bkagent.mjs node packages/dsh-plugin/mcp.js
```

MCP 没有审批通道，`pg_restore` / `pg_pitr` 一律失败关闭，返回 `isError` 并提示改用 preset 或 CLI。

### 10.2 智能体闭环：Goal / Step / Action / Memory

v1.2 起，目标本身成为控制库里的持久对象。`Goal` 保存操作者的原话与约束，`Step` 保存拆解（序号、意图、依赖、状态、尝试次数、审批人），`Action` 是产品自身动词的受控组合，最终仍由既有 Plan IR 执行。模型负责拆解与选择修复动作；核心负责校验、执行与裁决。分层与不变量见 [agent-loop.md](agent-loop.md)。

```mermaid
flowchart TD
  A["goal add<br/>目标 + 拆解 + 约束"] --> B["goal next<br/>取可运行步骤"]
  B --> C["goal run<br/>拼 argv → 既有命令"]
  C --> D{"步骤失败？"}
  D -->|"transient 且在预算内"| R["retry（确定性）"]
  R --> C
  D -->|"其余"| G["diagnose<br/>封闭候选集"]
  G -->|"approval:required"| H["人工 goal approve-step"]
  H --> C
  G -->|"replan"| P["goal remediate --kind replan"]
  P --> C
  G -->|"escalate / abandon"| S["停下并上报"]
  C --> M["memory_entries<br/>成功与失败签名"]
```

四条不变量决定了「自主」的边界：

| 不变量 | 含义 |
|---|---|
| 核心不发明步骤 | 拆解来自模型；核心只校验步数上限、序号唯一、依赖只能指向更早步骤、动作符合 capability grammar |
| 授权不随计划走 | 破坏性步骤需要该步骤上的人工 `approver`；`goal run` 仅在审批存在时追加 `--yes`，内层命令仍要过原有门禁，两把锁缺一不可 |
| 审批失败不产生 `replan` | `approval:required` 的候选集只有 `escalate`，否则「自我修正」会变成绕过双人复核换一个破坏性动作 |
| 凭据不进动作 | capability grammar 直接拒绝携带口令的 `--dsn`：动作会持久化并重放，口令必须由 `BKAGENT_DSN` / `.pgpass` / peer / GSSAPI 提供 |

`goal run` 与 `goal remediate` 的 JSON 载荷带 `hint`，取值封闭为四个。它与 `next` 不是同一件事：`next` 由调度器给出（当前是否可派发步骤），`hint` 由目标与步骤状态给出（本轮应当做什么），两者不一致时以 `hint` 为准。

| hint | 含义 | 允许的动作 |
|---|---|---|
| `run_step` | 仍有可运行步骤 | 再次 `goal run` |
| `remediate` | 存在失败步骤且候选集开放 | `goal remediate`，只能选候选集内的处置 |
| `await_approval` | 下一个可运行步骤是未审批的破坏性动作 | 请人在 CLI 执行 `goal approve-step`，不得改用其它动作绕行 |
| `done` | 目标已到终态或已转人工 | 停止并汇总 |

`hint` 由持久状态现算、不入库，因此不会与步骤状态不一致；`failed` 目标同样返回 `done`，因为 `escalate` 之后的决定属于人。

一次完整闭环，用一个目标串起前面几章的命令（第 4 步为破坏性动作）：

```sh
bkagent goal add --db .bkagent/control.db --target 127.0.0.1:5432/<db> \
  --intent '把 <db> 的最新逻辑备份恢复到 <db>_copy，并保留可核对的校验证据' \
  --steps-json '[{"intent":"确认实例身份","action":{"command":"inspect","args":["--dsn","postgres://<user>@127.0.0.1:5432/<db>"]}},
                 {"intent":"产出逻辑备份","dependsOn":[1],"action":{"command":"backup","args":["--dsn","postgres://<user>@127.0.0.1:5432/<db>","--database","<db>","--out","/var/backups/<db>.dump","--format","custom"]}},
                 {"intent":"校验备份","dependsOn":[2],"action":{"command":"verify","args":["--dsn","postgres://<user>@127.0.0.1:5432/<db>","--input","/var/backups/<db>.dump","--database","<db>"]}},
                 {"intent":"恢复到新库","dependsOn":[2],"action":{"command":"restore","args":["--dsn","postgres://<user>@127.0.0.1:5432/postgres","--input","/var/backups/<db>.dump","--database","<db>_copy","--create-database"]}}]' \
  --constraints-json '{"maxSteps": 10, "allowDestructive": true}'
```

`allowDestructive` 缺省为 `false`：含破坏性动作的拆解会被拒绝（`the goal does not allow destructive steps`），这是目标级开关，与逐步骤审批叠加。`goal add` 与 `goal plan` 都返回可运行顺序与相关记忆（`prior`），记忆因此参与规划，而非仅用于事后查询。

```mermaid
sequenceDiagram
  autonumber
  participant M as 模型 / 操作者
  participant CLI as bkagent goal
  participant Core as 确定性核心
  participant PG as 目标 PostgreSQL

  M->>CLI: goal add（拆解 + 约束）
  CLI->>Core: 校验步数、依赖、动作 grammar
  CLI->>CLI: goal run（取可运行步骤）
  CLI->>PG: inspect → backup → verify
  CLI->>Core: 第 4 步 restore 需要审批
  Core-->>M: diagnosis approval:required，candidates 仅 escalate
  M->>CLI: goal approve-step --approver dba
  CLI->>PG: restore（追加 --yes，仍过原有门禁）
  CLI->>Core: 目标 succeeded，写 step_attempts / memory_entries
```

第一次 `goal run` 会停在第 4 步：

![goal run 停在审批](assets/tutorial/14-goal-approval.png)

下列输出为节选：前三步均为 `succeeded`，此处只保留第一条。截图早于 `hint` 字段加入，下方 JSON 为当前输出。

```json
{
  "goalId": "gol_31752057-3818-4bd3-8ec7-7fa5179c9698",
  "state": "running",
  "executed": [{ "stepId": "stp_f2251146-…", "attempt": 1, "exitCode": 0, "state": "succeeded" }],
  "diagnosis": {
    "stepId": "stp_a603ed48-cfba-4958-a94f-8ce95a3a9453",
    "errorClass": "manual",
    "signature": "approval:required",
    "candidates": [{ "kind": "escalate", "reason": "the decision belongs to a human; stop and report" }],
    "requiresHuman": true
  },
  "progress": { "total": 4, "succeeded": 3, "failed": 0, "ready": 1 },
  "next": { "kind": "run", "stepId": "stp_a603ed48-…" },
  "hint": "await_approval"
}
```

审批由人在 CLI 完成，之后再次 `goal run` 只补执行剩余步骤：

![审批通过后继续执行](assets/tutorial/15-goal-approve-run.png)

```json
{
  "goalId": "gol_31752057-3818-4bd3-8ec7-7fa5179c9698",
  "state": "succeeded",
  "executed": [{ "stepId": "stp_a603ed48-…", "attempt": 2, "exitCode": 0, "state": "succeeded" }],
  "progress": { "total": 4, "succeeded": 4, "failed": 0, "abandoned": 0 },
  "next": { "kind": "done", "failed": false },
  "hint": "done"
}
```

账本与记忆均可查询：`goal show` 返回目标、步骤、每次尝试的退出码、错误类与失败签名；`memory search` 按签名检索历史结果（成功与失败均记录）：

```sh
bkagent goal show  --db .bkagent/control.db --goal <goal-id>
bkagent memory search --db .bkagent/control.db --target 127.0.0.1:5432/<db> --limit 5
```

| 失败之后 | 由谁决定 | 机制 |
|---|---|---|
| `transient` 且在尝试预算内 | 核心 | 自动 `retry`，不需要模型参与 |
| 需要换动作 | 模型 | `goal remediate --kind replan --action-json …`，原地替换该步骤动作，保留历史尝试与预算，不重连 DAG |
| 需要人 | 人 | `escalate` / `abandon`；`approval:required` 只允许 `escalate` |
| 进程崩溃留下 `running` 步骤 | 核心 | `goal run` 启动时以签名 `stalled` 记一次失败尝试，不猜副作用是否已发生 |

一次实际的 `replan`（本次执行）：第 2 步把库名写成不存在的 `bk_missing`，`goal run` 以 `errorClass: permanent`、`signature: schema:database-missing`（退出码 1）失败；诊断给出的候选为 `replan`（`requiresAction: true`）与 `escalate`。执行 `goal remediate --kind replan --action-json …` 后，该步骤回到 `ready`、目标回到 `planned`，返回 `hint: run_step`，再次 `goal run` 成功（`attempt: 2`）。这说明「自我修正」只替换动作，不改变门禁与历史；同时 `replan` 会清空该步骤已有的审批记录，替换后的破坏性动作须重新执行 `goal approve-step`。

dsh 侧对应四个工具：`bk_goal`（open / plan / next / status / diagnose）、`bk_step_run`、`bk_remediate`、`bk_recall`。**审批刻意不做成工具**：MCP 与模型都无法自行放行破坏性步骤，只能在 CLI 执行 `bkagent goal approve-step`。闭环行为契约写在 `presets/pg-dba/skills/goal-loop/SKILL.md`，由 `pnpm verify:skills` 的 MANIFEST 哈希守护；`bk_step_run` 与 `bk_remediate` 在失败与被拒时仍返回诊断或 `refused` 载荷，并附带 `exitCode`。

这套组合的等级是 **L1 受监督智能体**，判定尺子与证据链见 [agent-loop.md](agent-loop.md) §9。模型侧行为由决策层回放守住：`packages/dsh-plugin/test/goal-replay.test.js` 以固定决策序列经同一工具定义驱动真实子进程与真实控制库，断言 `hint` 的四个取值。

未做且不应描述为已实现：多智能体协作、记忆的向量检索、自由 DAG 重写、目标级并发；真实模型驱动这条闭环的端到端验收（E-09）仍未纳入发布准入检查。

## 11. 故障排查顺序

```mermaid
flowchart TD
  S["命令失败"] --> E{"退出码"}
  E -->|"2 用法"| U["读取拒绝信息首行<br/>通常缺少 --yes 或参数错误"]
  E -->|"3 连接"| C["psql 手动连接一次<br/>host / port / 认证方式"]
  E -->|"4 plan/probe"| P["inspect 是否通过<br/>providers 是否 READY"]
  E -->|"1 执行"| X["trace --plan 查看失败的步骤<br/>catalog 查看是否入册"]
  U --> R["按打印的下一步命令重试"]
  C --> R
  P --> R
  X --> R
```

| 现象 | 原因 | 处理 |
|---|---|---|
| `no such table: …` 启动即报 | 控制库已存在，但迁移目录缺失（单文件安装常见） | 设 `BKAGENT_MIGRATIONS` 指向包内 `dist/migrations`，或在旧控制库上重新执行迁移 |
| `no asset registered for target …` | 目标未登记，或 `host` / `port` / 库名与 `targetId` 不一致 | 按拒绝信息中的 `asset-set` 执行，并统一使用 `127.0.0.1` |
| `TOOL_MISSING(pgbackrest)` | 工具不在 `PATH` 上 | 安装或改走 `native-logical`，不要期待自动降级 |
| `connection refused` / 退出码 `3` | 连接串、端口或认证失败 | 先用 `psql` 以相同参数手动连接一次，再回到 bkagent |
| `pg_verifybackup` 找不到 | 位于 `/usr/lib/postgresql/<ver>/bin`，默认不在 `PATH` | 加入 `PATH`，或改用 `--format tar` 并接受 V0 缺失 |
| `dashboard --serve` 打不开 | 只绑定 `127.0.0.1` | 本机访问，或自建反向代理并加认证 |

排查顺序建议固定为：`inspect` → `providers` → `trace --plan` → `catalog` → `watchdog`。`trace` 用 `--ticket` 或 `--plan` 定位单次执行，可查看每一步的 argv 与退出码。

## 12. 附录：主线命令卡

```sh
# 0. 环境
export BKAGENT_DSN='postgres://<user>@127.0.0.1:5432/<db>'
export BKAGENT_DB=.bkagent/control.db      # 缺省值，可省略

# 1. 探测
bkagent inspect --format text
bkagent providers --format text

# 2. 登记资产（targetId 必须是 <host>:<port>/<database>）
bkagent asset-set --target 127.0.0.1:5432/<db> --engine postgres \
  --environment production --owner dba --criticality high \
  --data-classification internal --rpo-minutes 1440 --rto-minutes 240

# 3. 备份与校验
bkagent backup --database <db> --out /var/backups/<db>.dump --format custom
bkagent verify --input /var/backups/<db>.dump --database <db>

# 4. 台账
bkagent catalog
bkagent asset-rpo
bkagent report --since 7d
bkagent metrics

# 5. 恢复（先确认目标库名，再决定环境）
bkagent asset-set --target 127.0.0.1:5432/<db>_copy --engine postgres \
  --environment test --owner dba --criticality medium \
  --data-classification internal --rpo-minutes 2880 --rto-minutes 480
bkagent restore --dsn 'postgres://<user>@127.0.0.1:5432/postgres' \
  --input /var/backups/<db>.dump --database <db>_copy --create-database --yes

# 6. 观测
bkagent watchdog
bkagent dashboard --out /var/www/bkagent.html

# 7. 多步任务（可选）：目标闭环
bkagent goal add --target 127.0.0.1:5432/<db> \
  --intent '备份并校验 app 库' \
  --steps-json '[{"intent":"探测","action":{"command":"inspect","args":[]}},
                 {"intent":"备份","action":{"command":"backup","args":["--database","<db>","--out","/var/backups/<db>.dump","--format","custom"]},"dependsOn":[1]},
                 {"intent":"校验","action":{"command":"verify","args":["--input","/var/backups/<db>.dump","--database","<db>"]},"dependsOn":[2]}]'
bkagent goal run --goal <goalId>          # 逐步执行；失败即停并返回诊断
bkagent goal diagnose --step <stepId>     # 失败签名 + 允许的修复候选
bkagent goal remediate --step <stepId> --kind replan --action-json '{…}'
bkagent memory search --target 127.0.0.1:5432/<db>
```

## 13. 这份教程验证到什么程度

如实说明边界，避免将「未执行」记为「已通过」：

| 内容 | 状态 |
|---|---|
| `inspect`、`providers`、`asset-set`、`backup --mode logical`、`verify`、`catalog`、`asset-rpo`、`report`、`metrics`、`restore`（含三次门禁拒绝与一次通过）、`approve`、`approvals`、`watchdog`、`dashboard --out` | 在本地 PostgreSQL 16.15 上实际执行，输出为真实回显 |
| dsh 0.2.2-rc.4 安装、插件挂载与 `pg-dba` 预设 | 已执行：`--dump-config` 出现 `preset-pg-dba`，设置页显示「自定义 / PostgreSQL 备份恢复」且无加载失败；未用模型实际发起一次会话 |
| 智能体闭环：`goal add` / `next` / `run` / `diagnose` / `remediate` / `approve-step` / `show`、`memory search` | 在本地 PostgreSQL 16.15 上实际执行：4 步目标先停在 `approval:required`（退出码 1），审批后 `succeeded`；另一次目标以 `permanent` / `schema:database-missing` 失败，`replan` 后 `succeeded`（`attempt: 2`）；`memory search` 返回对应签名条目。决策层回放（`packages/dsh-plugin/test/goal-replay.test.js`）已在 `pnpm test` 内执行并通过。**未经模型驱动**，E-09 未纳入发布准入 |
| 双人复核的**通过态** | 未演示：需要第二个操作系统用户执行 `approve`，本教程只展示 `distinct: 1` 的拒绝与自审被忽略 |
| `--transport ssh` / `--transport kubectl`、物理备份、PITR、`pgbackrest-*`、`walg-*`、`retain`、MCP 入口 | 未执行，只给入口与前置条件 |
| V3 校验等级 | 未实现 |

相关的离线验收（E-08）与真实模型端到端（E-09）尚未纳入发布准入检查。E-09 的 harness 可用 `BK_E2E=1 node scripts/e2e-agent.mjs` 人工执行，断言与限制见 [e2e-agent.md](e2e-agent.md)；当前完成度以 [status.md](status.md) 为准。
