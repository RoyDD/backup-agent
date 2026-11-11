---
name: pg-troubleshoot
description: 诊断 PostgreSQL 备份/恢复失败，按故障目录定位签名并给出处置路径。
whenToUse: 备份或恢复失败、出现 WAL 缺口、权限错误、版本不匹配、磁盘不足时。
---

# 故障诊断

## 方法

1. 读取工具的退出码、stderr、错误分类（transient / permanent / manual）。
2. 在 `docs/failure-catalog.md` 中按签名匹配条目（E/S/R/P/V/A 系列）。
3. 先验证假设，再修改任何配置；不确定时向用户确认。

## 常见签名

| 签名 | 条目 | 处置 |
|---|---|---|
| `password authentication failed` | E-01 | 重新注入凭据；不要重试到锁定 |
| `database "x" does not exist` | E-03 / S-01 | 检查目标库清单 |
| `permission denied for table` | S-02 | 授予读取权限或 `pg_read_all_data` |
| `canceling statement due to statement timeout` | S-03 | 检查长事务/锁；按 transient 退避重试 |
| `unsupported version ... in file header` | R-01 | 升级 `pg_restore`，或用匹配版本 |
| `role "x" does not exist` | R-02 | `--no-owner` 或创建角色映射 |
| `recovery ended before configured recovery target` | P-01 | 目标超出可恢复窗口；检查 WAL 归档 |
| `stop point is before consistent recovery point` | P-02 | 目标早于 `stopLSN` |
| `has size ... in the manifest` | V-01 | 产物损坏；标记不可用 |
| `present in the manifest but not on disk` | V-02 | 产物缺失；标记不可用 |

## 规则

- 不删除 WAL、归档或产物来“消除错误”。
- 不对生产实例执行未经验证的修复命令。
- 每次诊断给出：签名、目录条目、根因假设、建议动作、回滚路径。
