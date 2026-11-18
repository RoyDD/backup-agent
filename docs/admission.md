# 本地准入检查

本仓库不配置 CI。准入检查在本地执行，入口是 `scripts/gate.sh`；结论写进当次交付报告，格式见 workspace 根 `docs/quality/quality-gate.md`。

不配置 CI 的原因：真实模型 E2E 需要 `dsh` 运行环境与外部模型凭据，仓库不保存这类 secret；把检查放在开发机上执行，检查项与判定语义不受托管环境限制。

## 两档

| 档位 | 命令 | 内容 | 耗时量级 |
|---|---|---|---|
| 日常 | `bash scripts/gate.sh` | typecheck、`build:cli`、`pnpm test`、`verify:skills` | 分钟级 |
| 发版 | `GATE_E2E=1 bash scripts/gate.sh` | 上一行全部内容，追加真实模型 E2E（E-09） | 十分钟级，含模型调用 |

发版档不是可选装饰：E-09 只有在这一档里执行，日常档不跑模型。

## 判定

退出码即结论：

| 退出码 | 含义 |
|---|---|
| `0` | 全部 PASS |
| `1` | 存在 FAIL，不得发版 |
| `3` | 无 FAIL 但存在 BLOCKED（例如 PostgreSQL 不可达、`DEEPSEEK_API_KEY` 缺失），不计为 PASS |

表格里每一行给命令原文与证据（退出码、用例统计、目标 id、产物字节数），不使用「正常」「没问题」这类结论。BLOCKED 与 SKIP 不得在总结中写成通过。

## 环境要求

| 依赖 | 要求 |
|---|---|
| Node | ≥ 22.5（本地验证环境 24.12） |
| pnpm | 由 `package.json` 的 `packageManager` 决定，当前 `pnpm@11.24.0` |
| PostgreSQL | `127.0.0.1:55416`，密码 `verify_pw`，版本 16；可用 `BK_TEST_DSN` 指向其他实例 |
| 客户端与服务端二进制 | `pg_dump`、`psql`、`pg_verifybackup`、`pg_basebackup` 需在 `PATH` 上，且版本不低于服务端 |
| dsh | 仅发版档需要，当前验证版本 `@deepseek-ai/dsh@0.2.2-rc.4` |
| 模型凭据 | 仅发版档需要，`DEEPSEEK_API_KEY`；或 `BK_E2E_SHARE_CREDENTIALS=1` 从 `~/.dsh/.credentials.yaml` 读取 |

PostgreSQL 不可达时，`gate.sh` 把测试项记为 BLOCKED 并以退出码 3 结束，而不是让集成用例以失败的形式暴露环境问题。

## 最近一次执行（2026-11-18）

```
| 检查项 | 结果 | 命令 | 证据 |
|---|---|---|---|
| 静态类型检查 | PASS | pnpm -r --parallel typecheck | exit 0 |
| CLI 构建 | PASS | pnpm build:cli | exit 0 |
| 单元与集成测试 | PASS | pnpm test | 71 files / 852 tests, exit 0 |
| 技能哈希校验 | PASS | pnpm verify:skills | 7 entries, exit 0 |
| 真实模型 E2E（E-09） | PASS | BK_E2E=1 node scripts/e2e-agent.mjs | goal=gol_6d381643…, hint=done, 1058 bytes |
```

同次验证的两条判定分支：`BK_TEST_DSN` 指向未监听端口时退出码 `3` 且测试项为 BLOCKED；不带 `GATE_E2E` 时四项 PASS、退出码 `0`。

## 覆盖与未覆盖

已进入检查：

- 静态类型检查（`pnpm -r --parallel typecheck`）；
- 单元与集成测试（`pnpm test`，含决策层回放 `packages/dsh-plugin/test/goal-replay.test.js`）；
- 技能哈希（`pnpm verify:skills`）；
- 真实模型 E2E（发版档，断言 `bk_goal` → `bk_step_run` → `hint: done` 与产物）。

仍未覆盖：

- 覆盖率（≥ 85% 语句 / ≥ 80% 分支）、变异得分（≥ 60%）、不稳定用例率：无对应工具执行；
- 离线演练（E-08，`scripts/offline-drill.sh`）：未接入准入，且本身只覆盖部分命令；
- 知识索引与评测：改动语料时手工执行；
- 故障注入 F-01–F-06 与混沌、状态机模型检验：未实现。

## 适用边界

本地执行意味着结论依赖执行者与环境：同一份脚本可能在一台机器上 PASS、在另一台因缺少 `dsh` 或模型凭据而 BLOCKED。因此交付报告必须写明执行机器上的实际结果，不得以其他机器的结论替代；BLOCKED 必须单列并说明补齐方式。
