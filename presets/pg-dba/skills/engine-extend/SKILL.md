---
name: engine-extend
description: 为 backup-agent 增加新数据库引擎或备份 provider 的实现清单与验收标准。
whenToUse: 需要支持 MySQL、Oracle、国产数据库，或新增一个备份实现时。
---

# 引擎扩展

## 扩展点

1. 新建 `packages/engine-<id>`，实现 `EngineAdapter`，并给出 `EngineDescriptor`
   （id、能力集合、服务器版本区间、所需工具及最低版本）。
2. 每个 provider 实现 §11 的 `ProviderAdapter` 八个操作：
   `inspect / plan / preflight / backup / restore / verify / catalog / prune`。
   `plan(op, …)` 必须与对应动词调用同一构造器；不实现的操作抛
   `ProviderOperationError('UNSUPPORTED_OPERATION', …)`，不静默降级。
3. `preflight` 复用 `preflightProvider`：版本矩阵 + 能力协商 + `--version` 工具探测。
   工具版本不得依据配置声明假定。
4. 在 `providers.ts` 注册（key 必须等于 `Plan.provider`）；描述符里的能力集合决定
   可用操作，`Plan.requires` 必须落在该集合内。
5. 复用 `runPlan`、`validatePlan` 的检查点与重试；不要在适配器内重写调度。
6. 新增 provider 时只实现 argv 构建与仓库边界（谁拥有产物、谁来删除）。
7. CLI 增加对应命令，参数校验在 CLI，业务语义在核心库。

## 验收

- 新 provider 的测试文件调用 `defineProviderContractSuite`
  （`packages/core/test/contract/provider-contract.suite.ts`），P-01–P-10 全绿。
- `bkagent providers --dsn …` 对该 provider 返回 ok（工具版本与版本矩阵就绪）。
- 单元测试覆盖 argv 构建（无 Shell 拼接、无凭据泄漏）与 catalog 解析。
- 一份真实集群的备份→破坏→恢复→行数一致性证据。
- 能力未声明时计划校验必须拒绝，不得静默降级。
- 故障签名补入 `docs/failure-catalog.md`，并映射到错误分类与预检规则。
- 保留与删除必须遵守仓库所有权：provider 仓库只通过其自身命令清理。

## 禁止

- 不在核心库中写引擎分支判断。
- 不把凭据放入 argv、日志或审计。
- 不绕过 `Plan` 直接执行命令。
- 不在 `preflight` 里把「探测不到版本」当作满足条件。
