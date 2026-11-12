---
source_id: wikiraw-gap-closure-round-3
title: 抓取记录：Citus 提交协议、citus_backup_restore、级联槽、ShardingSphere（2026-11-12）
url: llm-wiki://postgresql-backup-recovery/raw/articles/gap-closure-round-3-2026-11-12.md
kind: md
origin: wiki
tier: evidence
version: wiki-raw-2026-11-12
license: internal
---

# 第三轮缺口取证原文（2026-11-12）

证据等级 A（仓库原文与源码注释）。抓取方式：curl --http1.1 --retry 3 与 gh_grep。

## Citus 文档：多分片 UPDATE/DELETE 的提交协议

仓库 citusdata/citus_docs，develop/reference_dml.rst（原文）：

> When updates/deletes affect multiple shards as in the above example, Citus defaults to
> using a one-phase commit protocol. For greater safety you can enable two-phase commits by
> setting
>     SET citus.multi_shard_commit_protocol = '2pc';
> If an update or delete affects only a single shard then it runs within a single worker
> node. In this case enabling 2PC is unnecessary.

## Citus CHANGELOG：v11.0.2 移除该 GUC

仓库 citusdata/citus，CHANGELOG.md：

```
### citus v11.0.2 (June 15, 2022) ###
...
* Drops citus.single_shard_commit_protocol GUC, defaults to 2PC
* Drops support for citus.multi_shard_commit_protocol, always use 2PC
```

引入侧：版本头 citus v9.0.0 (October 7, 2019) 下列有
"Adds option citus.single_shard_commit_protocol"。

→ 结论：Citus ≥ 11.0.2 恒为 2PC（1PC 窗口不存在）；9.0.0–11.0.1 默认 1PC 且可 SET 切 2PC，
同一集群内不同会话可能处于不同协议；< 9.0.0 未取证。

## PostgreSQL 源码：槽同步要求上游非备库

仓库 postgres/postgres，src/backend/replication/logical/slotsync.c（注释原文）：

> We ensure that the 'primary_slot_name' exists on the remote server and the remote server
> is not a standby node.

> Additionally, drop any slots that are valid on the primary but got invalidated on the
> standby. This situation may occur due to the following reasons:
> - The 'max_slot_wal_keep_size' on the standby is insufficient to retain WAL records from
>   the restart_lsn of the slot.
> - 'primary_slot_name' is temporarily reset to null and the physical slot is removed.

→ 只证明逻辑槽同步路径排除备库上游；物理槽在级联中间节点的保留边界未取证。

## citus_backup_restore

gh_grep 全站检索：0 命中（无仓库、无代码引用、无文档提及）。不下"已废弃"断言。

## ShardingSphere 检索记录

| 检索词 | 范围 | 结果 |
|---|---|---|
| backup | apache/shardingsphere docs/document/content 下全部 Markdown | 仅概念性段落（单库 1TB 阈值、分片缓解单点备份压力），无备份/恢复功能章节 |
| quiesce | 全仓 | 仅 Oracle 方言 ANTLR 语法文件中的 quiesceClauses（SQL 解析规则） |

→ 经检索未发现跨库一致点或全局 quiesce；不写"它不提供"。

## 检索局限

gh_grep 覆盖公开仓库默认分支，不含私有仓库、issue 与邮件列表；Citus < 9.0.0 未取证。
