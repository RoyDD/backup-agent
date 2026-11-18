# 真实模型端到端（E-09）

门禁含义：真实模型必须通过真实工具面驱动目标闭环，工具轨迹与外部事实同时成立才算通过。

## 运行形态：`dsh headless --json`

2026-11-18 起，脚本改用 `dsh headless --json`，不再起 web 服务、不再抓 token URL、不再解压 `session.jsonl.zstd`：

1. 以用户 profile 为模板，在临时目录构造独立 `DSH_HOME`（`$DSH_HOME/profiles/headless` 的副本）；没有现成 profile 时（CI runner）改为让 dsh 在该目录生成出厂模板，不下载任何内容；
2. 用 `--patch` 叠加一份只存在于临时目录的 overlay，以 `insert` 形式注册 `@backup-agent/dsh-plugin`；
3. 预检：`--dump-config` 断言 overlay 已合成，并用 `createRequire(...).resolve()` 断言插件在**新位置**可解析；
4. 执行 `dsh headless --json --approval-policy never "<task>"`，按 NDJSON 事件断言轨迹；
5. `finally` 删除临时 `DSH_HOME`。

为什么替换：旧脚本覆盖 `~/.dsh/profiles/web/cordis.patch.yml` 再在 `finally` 恢复——它写的是用户自己的 profile；判定还要依赖解压后的会话转录。`headless --json` 直接把 `tool_call` / `tool_result` 作为结构化事件输出，断言对象从文本变成事件。

## 为什么不是预设路径

`dsh-headless` 只组合 `dsh-base` + `dsh-headless`，没有 `agent-preset-registry`，因此 `pg-dba` 预设无法在 headless 中挂载。E-09 因此把闭环指令写进任务文本，工具由插件提供。这带来一个明确边界：**预设的 persona、`goal-loop` 技能与六个 runbook 不在本次断言范围内**，它们仍只在 web 会话中生效。2026-11-12 的单命令记录来自 web 预设路径，保留作为历史证据。

## 运行

```sh
BK_E2E=1 \
BK_E2E_DSN='postgres://user:pass@127.0.0.1:5432/postgres' \
BK_E2E_DATABASE=postgres \
BK_E2E_SHARE_CREDENTIALS=1 \
node scripts/e2e-agent.mjs
```

| 变量 | 作用 |
|---|---|
| `BK_E2E` | 必须为 `1`，否则脚本以退出码 2 拒绝执行 |
| `BK_E2E_DSN` / `BK_E2E_DATABASE` / `BK_E2E_OUT` / `BK_E2E_CONTROL_DB` | 目标、库名、产物路径、控制库路径 |
| `BK_E2E_DSH_HOME` | 作为模板的 dsh home，默认 `$DSH_HOME` 或 `~/.dsh` |
| `BK_E2E_SHARE_CREDENTIALS` | `1` 时从源 `.credentials.yaml` 读出 `refs` 并以环境变量传入子进程；默认不传 |
| `BK_E2E_TIMEOUT_MS` | 单次运行上限，默认 600000 |
| `BK_E2E_KEEP_HOME` | `1` 时保留临时 home 以便排查 |

前置条件：`dsh` 在 `PATH` 上、`dist/bkagent.mjs` 已构建（缺失时脚本自动 `pnpm build:cli`）、PostgreSQL 可达、模型凭据可用。

关于凭据：把 `.credentials.yaml` 复制进临时 home 不足以让 provider 读到密钥（该文件由 `@deepseek-ai/dsh-credentials-local` 按自己的所有权与锁规则提供）。dsh 的凭据优先级是「`$DSH_HOME/.credentials.yaml` > 继承的环境变量 > cwd 的 `.env` > `$DSH_HOME/.env`」，因此脚本选择第二层：只在显式开启时把 `refs` 导出为环境变量。

## 断言

- 轨迹中出现 `bk_goal`（`op=open`）与至少一次 `bk_step_run`；
- 未调用任何破坏性工具（`pg_restore` / `pg_pitr` / `pgbackrest_restore` / `walg_restore`）；
- 至少一个目标类 `tool_result` 携带 `hint`，且最终出现 `hint: "done"`，对应 `state` 为 `succeeded`；
- `executed` 至少两步且全部 `succeeded`；
- 无 `status: "error"` 的工具结果；
- 最终回答非空；
- 备份产物存在且字节数大于 0。

自然语言措辞不做断言，因为模型输出不确定；断言对象是工具轨迹与外部事实。

## 记录（2026-11-18）

模型：`deepseek-official / deepseek-v4-flash`（`agent-default-model` 的默认路由）。

```json
{
  "ok": true,
  "mode": "dsh headless --json",
  "sessionId": "session-9ac71d99-e5ea-4f71-a062-d144cc4802af",
  "goalId": "gol_2aa1ac39-1034-448f-b084-99d705522c00",
  "tools": ["bk_goal", "bk_step_run", "bk_goal", "bash"],
  "hints": ["done"],
  "executed": [
    { "attempt": 1, "exitCode": 0, "state": "succeeded" },
    { "attempt": 1, "exitCode": 0, "state": "succeeded" }
  ],
  "artifact": { "path": "/tmp/bkagent-e2e.dump", "bytes": 1058 }
}
```

观察结论：
- 模型按任务文本先 `bk_goal op=open` 提交两步拆解，再用一次 `bk_step_run` 推进到 `hint: done`；`goal run` 在同一调用内连续执行了两个可运行步骤。
- 失败路径与审批路径未被触发：任务本身不产生失败，也没有破坏性动作。因此这条记录证明「模型会按契约开启并推进目标」，不证明「模型会在失败时只在候选集内选择」。
- 模型额外调用了一次 `bash`（产物核对），尽管类型化工具已够用。这是模型行为，不是脚本缺陷，但不计入断言。

同日另有两次运行，覆盖准入路径：

- `GATE_E2E=1 scripts/gate.sh` 全量入口：`gol_296856f3-7bee-4fd9-92c9-aa21878a474e`，`hint=done`，产物 1058 字节，`gate.sh` 五项全 PASS、退出码 0。
- 全新 `DSH_HOME`（无现成 profile，走 bootstrap 分支，等价于 CI runner）：`gol_04ed697b-4899-431f-bb5a-b003430aa9bd`，两步 `succeeded`，产物 1058 字节。

## 未覆盖

- **失败与修复轨迹**：`permanent` 失败 → `diagnose` → `remediate --kind replan` 的模型侧决策仍无真实模型证据；该路径目前由决策层回放守住（`packages/dsh-plugin/test/goal-replay.test.js`）。
- **审批路径**：破坏性步骤需要人在 CLI 执行 `goal approve-step`，脚本不提供该通道，也不应该提供。
- **预设路径**：见上文，headless 无预设注册表。
- **发布准入**：本仓库没有 CI，脚本仍需人工执行，因此 E-09 仍**不满足**「全部通过方可发版」。把它接进发布准入需要一条能运行 dsh 与 PostgreSQL 的流水线。

## 历史记录（2026-11-12，web 预设路径）

模型：`deepseek-official / deepseek-v4-flash`。

```
session session-8a654fce-7aaf-468a-bce1-c6552ffeb53d on preset pg-dba
tools: skill, skill, pg_inspect, pg_backup, pg_verify, bash, pg_catalog
artifact: /tmp/bkagent-e2e.dump (1581 bytes)
verify: ok=true, public.t 50/50, restoreExitCode=0
```

该次运行还暴露并修复了两个预设缺陷：

- `tool-fs-search` 需要 `sampleOverCapGlobResults`；缺失时预设挂载失败（`agent-presets: preset "pg-dba" failed to mount`）。
- `pg_backup` 现在始终传控制库，与 `pg_restore`、`pg_catalog` 一致，产物无需额外参数即可入册。
