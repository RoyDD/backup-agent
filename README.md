# backup-agent

PostgreSQL 备份恢复 Agent 的确定性内核。设计基线见 `../docs/plan-v1.1.md`。

## 状态

P0 骨架、P0.5 故障模式目录、P1 逻辑备份与恢复均已完成：

- P0：领域模型、Plan IR 校验/指纹/重基、`Executor` 端口与本地实现、SQLite 控制库（Outbox / 租约与 fencing / 对账）、`bkagent inspect`。
- P0.5：57 条故障目录、15 条本地复现、错误分类与预检规则（`docs/failure-catalog.md`）。
- P1：`pg_dump` / `psql` 逻辑备份与恢复、Step DAG 执行器、恢复校验（临时库行数比对）、`bkagent backup|restore|verify`。
- P2：`pg_basebackup` 物理备份、`pg_verifybackup` 完整性校验、PITR 计划（配置写入、恢复启动、promote 断言）、`bkagent backup --mode physical` 与 `bkagent pitr`。

P3（pgBackRest / WAL-G）尚未开始。

## 结构

```
packages/
  core/                 @backup-agent/core
    src/domain/         标识、风险、能力、资产、主体、模型策略、Plan、状态机
    src/ports/          Executor / Repository / Engine / Clock 端口
    src/plan/           校验、指纹、重基
    src/executor/       本地执行器、错误分类
    src/runner/         谓词求值、Step DAG 执行、重试、检查点
    src/persistence/    SQLite 控制库、Outbox、租约、对账
    src/testkit/        FakeExecutor、FixedClock
  engine-postgres/      @backup-agent/engine-postgres
    src/probe.ts        实例探测
    src/logical.ts      pg_dump / pg_restore 计划构建
    src/physical.ts     pg_basebackup 与 PITR 计划构建
    src/verify.ts       恢复校验与行数比对
  cli/                  @backup-agent/cli（bkagent）
```

## 开发

```sh
pnpm install
pnpm test
pnpm -r typecheck
pnpm bkagent inspect --dsn 'postgres://user:pass@127.0.0.1:5432/postgres' --format text
pnpm bkagent backup  --dsn '...' --database app --out /backups/app.dump --format custom
pnpm bkagent restore --dsn '...' --input /backups/app.dump --database app_restored --create-database --yes
pnpm bkagent verify  --dsn '...' --input /backups/app.dump
pnpm bkagent backup  --dsn '...' --mode physical --out /backups/base --format plain
pnpm bkagent pitr    --dsn '...' --data-dir /restore --port 55417 --log /tmp/rec.log \
                     --restore-command 'cp /archive/%f %p' --target-time '2026-01-01 00:00:00+00' --yes
```

`inspect` 通过 `psql` 读取实例信息；`restore` 在建库或 `--clean` 时属破坏性操作，须显式 `--yes`。凭据仅经子进程环境变量传递，不出现在 argv 或输出中。

## 约束

- 确定性核心为状态唯一写入者；智能体层只做意图解析与呈现。
- `Plan` 为 Step DAG，每步必须声明 `idempotencyKey`，执行前重新求值前置条件。
- 外部副作用与状态迁移同事务写入 Outbox；投递至少一次，接收端按 `outbox_id` 去重。
- 租约带单调递增 fencing token；过期写入被拒绝。
- 控制库仅经 `Repository` 端口访问。
- 使用 `node:sqlite`（Node >= 22.5，仍标记为实验特性）。
