# PG 备份恢复证据库 —— 基线（P0）与别名词典（P1）

- 日期：2026-11-12（P0 于 2026-11-11）
- 状态：P0/P1 产出，待评审
- 代码：`packages/knowledge`（`@backup-agent/knowledge`）
- 定位：开发/运维期的文档问答与排障导航；**不参与运行期 Plan 生成**，因此不触碰 `docs/plan-v1.1.md` 的 ADR-010（故障目录为编译期输入，运行期不做自由检索）。ADR-009（一期不引入向量库）与本方案同向：无 embedding。

## 1. 为什么是 SAG2 而不是向量 RAG

SAG2（arXiv 2610.22588）把「原文 passage → 词法索引 → 查询时用已选证据扩展检索」做到零建库成本：MuSiQue 11,656 passage 建库 2.36 s、25.87 MiB、零模型调用，R@10 从纯 BM25 的 54.41% 提到 86.62%。其消融显示增益来自**每轮打分 + 已选证据作为上下文**（只做词法扩展、最后打一次分只有 61.34%），所以后续实现必须是「逐轮重排」，而不是 query expansion 兜一层。

对本仓库更关键的是：`code/docs/failure-catalog.md` 已经有 57 条带可观测签名、预检 ID 与分类的条目——这正好替代 SAG v1 里「用 LLM 抽事件和实体」那一步，实体是手写且精确的，抽取成本为零。

## 2. 语料

`code/knowledge-corpus/`：固定快照 + `manifest.json`（url / version / license / sha256 / 状态）。项目内文档不入快照，按原路径就地读取：`docs/plan-v1.0.md`、`docs/plan-v1.1.md`、`code/docs/failure-catalog.md`、`code/docs/failure-catalog/evidence-2026-11-11.md`。

| 来源 | 版本 | 许可 | 说明 |
|---|---|---|---|
| pg16 continuous-archiving / backup-dump / app-pgbasebackup / app-pgdump / app-pgrestore / app-pgverifybackup / runtime-config-wal / wal-internals / monitoring-stats | pg16 | PostgreSQL License | 归档、PITR、工具、WAL 配置、累计统计视图 |
| pg14 / pg15 / pg17 continuous-archiving、pg17 app-pgbasebackup | pg14–17 | PostgreSQL License | 兼容矩阵的版本差异 |
| pgbr-user-guide | 2.x | MIT | 教程级（概念、快速上手、保留、恢复、PITR） |
| pgbr-command | 2.x | MIT | 命令参考（archive-push/get、backup、expire、restore、stanza-*、verify 及其选项） |
| walg-postgresql / walg-readme | master | Apache-2.0 | 命令级文档，带标题结构 |

`pg16-backup` 是目录页（3 KB、无正文），抓取成功但不参与出题。

## 3. 索引

| 指标 | corpus v1（P0） | corpus v2（P1） |
|---|---|---|
| 来源 / passage | 21 / 1,309 | 22 / 1,514 |
| 正文字符 | 710,688（694 KiB） | 900,432（879 KiB） |
| SQLite 文件 | 2,452 KiB | 2,908 KiB |
| 建库耗时 | 412 ms | 475 ms |
| 模型调用 | 0 | 0 |

分块：2200 UTF-16 目标、标题变化即切、标题路径进正文；长表格（≥8 行）逐行成 passage，故障目录的每一行因此是独立可检索事件。中文侧索引 token 串（ASCII 词完整 + CJK unigram/bigram），查询同构。

**pgBackRest 标题修复**：其 HTML 没有 `h1–h6`，用 `div.sectionN-title` 表达层级。抓取脚本按 `sectionN → h(N+1)` 合成标题（并删除页内 TOC），因此 P1 起 pgBackRest 的 passage 有了 `Archive Push (archive-push) > Command Options > …` 这样的路径，不再是一整片命令转录。

## 4. 评测集

`packages/knowledge/eval/questions.jsonl`：100 题，中英各 50，gold 平均 2.83 个 passage。

| 类型 | 题数 | 意图 |
|---|---|---|
| fact | 34 | 单跳事实（参数、视图字段、命令选项） |
| multihop | 26 | 跨文档：症状 → 机制 → 窗口/命令 |
| troubleshoot | 22 | 故障签名 → 目录条目 → 预检规则 |
| confusable | 18 | 近义概念辨析（custom/directory、on/always、expire/delete、VRP/最近成功） |

gold 声明为 `{source, heading?, contains?}`，或 `{source, passage:"source#ordinal"}` 精确固定。解析到 0 个 passage 时 `eval` 退出码 1 并列出问题——题集坏了要立刻可见。

## 5. 基线（corpus v1，P0）

单轮 BM25、无别名扩展：

| 指标 | 值 |
|---|---|
| R@1 / R@2 / R@5 / R@10 | 16.37% / 23.78% / 29.55% / **39.66%** |
| AE@10 / MRR@10 | 28.00% / 0.3089 |
| troubleshoot R@10 | 77.27% |
| multihop R@10 | 17.95% |
| en / zh R@10 | 47.54% / 31.79% |

结论：结构化目录（签名→条目）几乎直接命中；多跳与中文尾部召回是短板。

## 6. P1：别名词典 + 查询改写

`src/text/aliases.ts`：手写领域词典（约 80 条中文词条 + 10 条英文缩写），只做**查询侧**改写——索引仍是逐字快照，词典无法改变任何 passage 的内容。匹配按最长词优先并消费命中区间，所以「时间点恢复」不会同时触发「恢复」；扩展词保持高精度，错配一个词会拖累整套题。

语料同时补入 `pgbr-command`（+200 K 字符）并修复 pgBackRest 标题，因此 corpus v2 的绝对值与 §5 不可直接比较：更完整的语料意味着更多干扰项，这是更公平也更难的一套。

| 指标（corpus v2） | expand=none | expand=aliases | Δ |
|---|---|---|---|
| R@1 | 15.87% | 15.67% | −0.20 |
| R@2 | 22.23% | 24.33% | +2.10 |
| R@5 | 29.17% | 33.95% | +4.78 |
| R@10 | 37.55% | **41.94%** | **+4.39** |
| AE@10 | 26.00% | 30.00% | +4.00 |
| MRR@10 | 0.2997 | 0.3126 | +0.0129 |

分类型：

| 类型 | none R@10 | aliases R@10 | Δ |
|---|---|---|---|
| fact | 29.00% | 40.20% | +11.20 |
| multihop | 17.95% | 20.19% | +2.24 |
| troubleshoot | 71.15% | 71.15% | 0 |
| confusable | 40.93% | 40.93% | 0 |

分语言：

| 语言 | none R@10 | aliases R@10 | Δ |
|---|---|---|---|
| zh | 32.79% | 40.45% | +7.66 |
| en | 42.31% | 43.42% | +1.11 |

## 7. P2：SAG2 主循环

`src/retrieval/` 实现三档检索，默认 `sag2`：

- `bm25`：单轮词法基线。
- `sag2`：BM25 top-100 → 确定性打分 → 选 ≤10 种子 → 抽 ≤20 扩展词 → 逐词检索并交错去重 → **用已覆盖的证据作为上下文重新打分**，默认 2 轮。
- `expand-only`：对照。同样的扩展词只抽一次，最后打一次分，不重选。

打分器是 SAG2 中 JEV 的确定性替代：问题词覆盖（idf 加权）、标识符命中、标题命中、归一化 BM25。**种子选择**额外加 `novelty`（当前上下文尚未覆盖的问题面向），否则每轮都会重选同一段改写，扩展词不变、循环空转——这是实现时踩到的第一个坑。

| 模式（corpus v2，100 题） | R@1 | R@2 | R@5 | R@10 | AE@10 | MRR@10 | p50 |
|---|---|---|---|---|---|---|---|
| `bm25`（= P1 基线） | 15.67% | 24.33% | 33.95% | 41.94% | 30.00% | 0.3126 | 2 ms |
| `expand-only` | 16.01% | 26.26% | 35.08% | 47.13% | 37.00% | 0.3400 | 25 ms |
| `sag2` r1 | 16.01% | 26.26% | 35.08% | 47.13% | 37.00% | 0.3400 | 30 ms |
| **`sag2` r2（默认）** | 16.01% | 25.76% | 35.08% | **48.27%** | **38.00%** | **0.3405** | 46 ms |
| `sag2` r3 | 16.01% | 25.76% | 35.08% | 48.27% | 38.00% | 0.3405 | 71 ms |
| `sag2` r2 + MMR | 16.01% | 23.09% | 34.38% | 43.69% | 33.00% | 0.3283 | 46 ms |

`sag2` r2 分类型：fact 49.54% / multihop 23.72% / troubleshoot 75.35% / confusable 48.26%（R@10）；分语言 zh 46.67% / en 49.87%。

## 8. 结论

1. **增益主要来自扩展，而不是逐轮重排**：`sag2` r2 48.27% 对 `expand-only` 47.13%，逐轮重选只贡献 +1.14pp。论文里这一档差距是 86.62% vs 61.34%——差别在于 JEV 是语义判定，而我们的代理打分器只会算词面覆盖。**结论是打分器而非循环结构才是瓶颈**，继续加轮次不会有收益（r3 与 r2 完全相同，只多 26 ms）。
2. **MMR 在这个语料上是有害的**（48.27% → 43.69%）：本章题集的 gold 经常是同一 section 的多段近重复（故障目录一行一段、命令选项每组一段），多样性惩罚把正确答案挤出了 top-k。默认关闭，`--diversify on` 保留作对照。这是与论文相反的结果，原因是评测单元不同，不是实现错误。
3. **别名词典的收益保持住且跨模式稳定**：bm25 41.94% → sag2 48.27%，zh 46.67% / en 49.87%，中英差距 3.2pp。扩展词没有在更多候选里被稀释。
4. **多跳仍是最弱的一类（23.72%）**：跨段证据需要「A 段的术语送回 B 段检索」，词面扩展只能做到一步；再往上要么加语义重排（P3 本地 reranker / JEV），要么改评测单元。
5. **延迟完全可接受**：p50 46 ms、p95 65 ms，单机、无模型。论文中 SAG v1 的单查询 18.67 s 在这里是另一个量级。
6. **gold 保持小集合**（平均 2.83、最大 8）：早期版本一个术语命中 58 个 passage，指标不可解释；现在用 `heading` + `contains` 或 `passage` 精确固定。

## 9. 下一步

| 顺位 | 动作 | 验收 |
|---|---|---|
| P3 | 本地 reranker（Qwen3-Reranker-0.6B 或等价离线模型）替换代理打分器的 coverage 项 | multihop R@10 > 23.72%，全量 R@10 ≥ 48.27% |
| P3 | JEV API 档（手动、记录模型版本与成本） | 复现论文口径，与离线档并列报告 |
| P2+ | 扩展词选择加入邻近性（term 与问题词在段内共现距离） | r2 增益 > 1.14pp |
| P1+ | 语料补 `pg_probackup`、WAL-G 的 S3/delete 细节 | 覆盖 provider 差异 |
| P4 | 接 dsh agent 层只读工具（只返回证据+引用） | 参数校验与呈现留在适配层 |
