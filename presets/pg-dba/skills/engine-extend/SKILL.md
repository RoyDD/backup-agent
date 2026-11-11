---
name: engine-extend
description: 为 backup-agent 增加新数据库引擎或备份 provider 的实现清单与验收标准。
whenToUse: 需要支持 MySQL、Oracle、国产数据库，或新增一个备份实现时。
---

# 引擎扩展

## 扩展点

1. 新建 `packages/engine-<id>`，实现 `EngineAdapter`：
   - `probe(executor, connection)`：版本、角色、磁盘、对象清单；
   - `planLogicalBackup` / `planLogicalRestore`：返回 Step DAG；
   - 能力集合必须如实声明（`logical`、`physical`、`pitr` 等）。
2. 复用 `runPlan`、`validatePlan`、`runPlan` 的检查点与重试；不要在适配器内重写调度。
3. 新增 provider 时只实现 argv 构建与仓库边界（谁拥有产物、谁来删除）。
4. CLI 增加对应命令，参数校验在 CLI，业务语义在核心库。

## 验收

- 单元测试覆盖 argv 构建（无 Shell 拼接、无凭据泄漏）。
- 一份真实集群的备份→破坏→恢复→行数一致性证据。
- 能力未声明时计划校验必须拒绝，不得静默降级。
- 故障签名补入 `docs/failure-catalog.md`，并映射到错误分类与预检规则。
- 保留与删除必须遵守仓库所有权：provider 仓库只通过其自身命令清理。

## 禁止

- 不在核心库中写引擎分支判断。
- 不把凭据放入 argv、日志或审计。
- 不绕过 `Plan` 直接执行命令。
