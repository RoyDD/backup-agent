# backup-agent

PostgreSQL 备份恢复 Agent 的确定性内核。设计基线见 `../docs/plan-v1.1.md`。

## 状态

P0 骨架已完成：领域模型、Plan IR 校验/指纹/重基、`Executor` 端口与本地实现、`FakeExecutor` 契约测试、SQLite 控制库（Outbox / 租约与 fencing / 对账）、`bkagent inspect`。

P0.5（故障模式调研）尚未开始。

## 结构

```
packages/
  core/                 @backup-agent/core
    src/domain/         标识、风险、能力、资产、主体、模型策略、Plan、状态机
    src/ports/          Executor / Repository / Clock 端口
    src/plan/           校验、指纹、重基
    src/executor/       本地执行器、错误分类
    src/persistence/    SQLite 控制库、Outbox、租约、对账
    src/testkit/        FakeExecutor、FixedClock
  cli/                  @backup-agent/cli（bkagent）
```

## 开发

```sh
pnpm install
pnpm test
pnpm -r typecheck
pnpm bkagent inspect --dsn 'postgres://user:pass@127.0.0.1:5432/postgres' --format text
```

`inspect` 通过 `psql` 读取实例信息；凭据仅经子进程环境变量传递，不出现在 argv 或输出中。

## 约束

- 确定性核心为状态唯一写入者；智能体层只做意图解析与呈现。
- `Plan` 为 Step DAG，每步必须声明 `idempotencyKey`，执行前重新求值前置条件。
- 外部副作用与状态迁移同事务写入 Outbox；投递至少一次，接收端按 `outbox_id` 去重。
- 租约带单调递增 fencing token；过期写入被拒绝。
- 控制库仅经 `Repository` 端口访问。
- 使用 `node:sqlite`（Node >= 22.5，仍标记为实验特性）。
