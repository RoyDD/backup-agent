# CI 与发布准入

流水线定义在 `.github/workflows/quality-gate.yml`，检查项与判定语义由 `scripts/gate.sh` 定义。CI 与本地调同一个脚本，避免两套检查各自演化。

## 两段式

| 作业 | 触发 | 内容 | 耗时量级 |
|---|---|---|---|
| `gate` | `push` 到 `main`、`pull_request`、手工 | `scripts/gate.sh`：typecheck、`build:cli`、`pnpm test`、`verify:skills` | 分钟级 |
| `release-gate` | tag `v*`、手工 | `GATE_E2E=1 scripts/gate.sh`：上一行的全部内容，追加真实模型 E2E（E-09） | 十分钟级，含模型调用 |

`release-gate` 依赖 `gate`，因此发版前不会跳过静态检查直接跑模型。

## 本地复现

```sh
cd code
pnpm install --frozen-lockfile
bash scripts/gate.sh                    # 与 gate 作业等价
GATE_E2E=1 bash scripts/gate.sh         # 与 release-gate 作业等价，需要 dsh 与模型凭据
```

`gate.sh` 的退出码即判定：

| 退出码 | 含义 |
|---|---|
| `0` | 全部 PASS |
| `1` | 存在 FAIL，不得发版 |
| `3` | 无 FAIL 但存在 BLOCKED（例如 PostgreSQL 不可达、`DEEPSEEK_API_KEY` 缺失），不计为 PASS |

表格里每一行给命令原文与证据（退出码、用例统计、目标 id、产物字节数），不使用「正常」「没问题」这类结论。

## 环境要求

- **PostgreSQL**：`services.postgres` 用 `postgres:16`，端口映射 `55416:5432`，密码 `verify_pw`，与仓库默认 DSN 一致。`gate.sh` 先探测可达性，不可达时把测试项记为 BLOCKED 而不是让集成用例失败。
- **客户端与服务端二进制**：`pg_dump`、`psql`、`pg_verifybackup`、`pg_basebackup` 不在 Ubuntu 镜像的默认 `PATH` 上，作业从 `apt.postgresql.org` 安装 `postgresql-client-16`（版本必须不低于服务端）。
- **Node**：24（`package.json` 要求 ≥ 22.5，本地验证环境为 24.12）。
- **pnpm**：版本由 `package.json` 的 `packageManager` 决定，`pnpm/action-setup` 直接读取，不在两处各写一遍。
- **dsh**：仅 `release-gate` 安装 `@deepseek-ai/dsh@0.2.2-rc.4`（dist-tag `next`），与本地验证版本一致。E2E 脚本在全新 `DSH_HOME` 上自建 profile，因此不依赖任何持久化的 dsh 状态。
- **模型凭据**：仓库 secret `DEEPSEEK_API_KEY`。缺失时 `gate.sh` 把 E-09 记为 BLOCKED 并以退出码 3 结束，`release-gate` 失败——发版前不允许用「未执行」冒充「通过」。

## 覆盖与未覆盖

已进入流水线：

- 静态类型检查（`pnpm -r --parallel typecheck`）；
- 单元与集成测试（`pnpm test`，含决策层回放 `packages/dsh-plugin/test/goal-replay.test.js`）；
- 技能哈希（`pnpm verify:skills`）；
- 真实模型 E2E（`release-gate`，断言 `bk_goal` → `bk_step_run` → `hint: done` 与产物）。

仍为手工或 BLOCKED：

- 覆盖率（≥ 85% 语句 / ≥ 80% 分支）、变异得分（≥ 60%）、不稳定用例率：无对应工具执行；
- 离线演练（E-08，`scripts/offline-drill.sh`）：未接入，且本身只覆盖部分命令；
- 知识索引与评测：改动语料时手工执行；
- 故障注入 F-01–F-06 与混沌、状态机模型检验：未实现。

## 首次上线的风险

`.github/workflows/quality-gate.yml` 尚未在 GitHub 上执行过，本地验证覆盖的是 `scripts/gate.sh` 与 `scripts/e2e-agent.mjs` 本身。首次运行需要观察四点：

1. `apt.postgresql.org` 源在 runner 上可用，且 `lsb_release -cs` 对应的发行版有 `postgresql-client-16`；
2. runner 上 `pnpm install --frozen-lockfile` 能解析 `packageManager: pnpm@11.24.0`；
3. `npm install -g @deepseek-ai/dsh@0.2.2-rc.4` 可用（该版本是 dist-tag `next`，不是 `latest`）；
4. `release-gate` 的模型调用在 45 分钟上限内完成；本地单次运行约 1 分钟模型时间，加上装依赖与构建。

任何一项不满足都会让作业失败而不是静默跳过，符合「SKIP 与 BLOCKED 不计为 PASS」的要求。
