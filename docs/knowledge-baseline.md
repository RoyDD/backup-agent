# PG 备份恢复证据库 —— 基线（P0）与别名词典（P1）

- 日期：2026-11-12（P0 于 2026-11-11）
- 状态：P0/P1 产出，待评审
- 代码：`packages/knowledge`（`@backup-agent/knowledge`）
- 定位：开发/运维期的文档问答与排障导航；**不参与运行期 Plan 生成**，因此不触碰 `docs/plan-v1.1.md` 的 ADR-010（故障目录为编译期输入，运行期不做自由检索）。ADR-009（一期不引入向量库）与本方案同向：无 embedding。

## 1. 为什么是 SAG2 而不是向量 RAG

SAG2（arXiv 2610.22588）把「原文 passage → 词法索引 → 查询时用已选证据扩展检索」做到零建库成本：MuSiQue 11,656 passage 建库 2.36 s、25.87 MiB、零模型调用，R@10 从纯 BM25 的 54.41% 提到 86.62%。其消融显示增益来自**每轮打分 + 已选证据作为上下文**（只做词法扩展、最后打一次分只有 61.34%），所以后续实现必须是「逐轮重排」，而不是 query expansion 兜一层。

对本仓库更关键的是：`code/docs/failure-catalog.md` 已经有 62 条带可观测签名、预检 ID 与分类的条目——这正好替代 SAG v1 里「用 LLM 抽事件和实体」那一步，实体是手写且精确的，抽取成本为零。

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

`packages/knowledge/eval/questions.jsonl`：108 题，中英各 54，gold 平均 2.73 个 passage（当前索引口径；原 100 题，`w01`–`w08` 为同步 wiki 内容后补题）。

| 类型 | 题数 | 意图 |
|---|---|---|
| fact | 36 | 单跳事实（参数、视图字段、命令选项） |
| multihop | 28 | 跨文档：症状 → 机制 → 窗口/命令 |
| troubleshoot | 24 | 故障签名 → 目录条目 → 预检规则 |
| confusable | 20 | 近义概念辨析（custom/directory、on/always、expire/delete、VRP/最近成功） |

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

## 8. P3：打分后端可插拔

先给结论：**这台机器上跑不了模型档**——无 `torch`/`transformers`/`onnxruntime`，`huggingface.co` 不可达，也没有 JEV 的 key。所以 P3 做的是端口与协商，而不是伪造一组模型数字。

`src/ports/scorer.ts` 定义 SAG2 里 JEV 的位置：

| 后端 | 用途 | 约束 |
|---|---|---|
| `lexical`（默认） | 确定性特征混合（coverage / identifier / heading / lex） | 离线、零依赖；P2 的 48.27% 即由它测得 |
| `command` | 外部 reranker 子进程 | argv-only、`shell: false`、stdin JSON → stdout `{scores}`、超时即杀；与 `Executor` 同一执行面（E-04） |
| `http` | 远端打分服务（JEV 经薄适配接入） | 批量 POST、key 只从环境变量读、超时 30 s |

协商是 fail-closed：`--scorer command` 缺 argv、`--scorer http` 缺 URL、未知后端，一律退出码 2 并说明原因，**不静默退回 lexical**。`bkagent knowledge scorer` 提供 `health()` 探针，`ask`/`eval` 在开跑前先探一次。

契约测试 `test/contract/scorer-contract.suite.ts`（C-S01–C-S03：逐候选一个有限分数且顺序一致、同请求确定性、`health()` 必须给出原因）由三个后端共同实现；另有失败面用例：非零退出带 stderr、超时 250 ms 被杀、`http` 非 200 带 body、候选文本里的 `; touch …` 不产生任何文件。

接线验证（非质量结论）：把测试夹具当作 `command` 后端跑全量 100 题，R@10 变成 34.20%、p50 196 ms——排序确实由该后端决定，端口不是装饰。夹具只是词面重叠，因此这个数字不能与 `lexical` 并列比较。

### 真模型验证（2026-11-12）

JEV 原文那条路走不通：OpenRouter 的 `typesafe/jev-router` 返回 **402（账户从未充值）**，opencode-go 目录里也没有 jev 模型。可用的真实模型只有 OpenCode Go 的 `deepseek-v4.1-flash`（`https://opencode.ai/inference/go/openai/v1`，需要 API key 与 `x-opencode-session`）。

用 `scripts/rerank-llm.mjs`（OpenAI 兼容 shim）把它接到 `--scorer command`，在 **24 题平衡子集**（每类 6 题、中英各 3）上跑同一套 `sag2` 循环，`--scorer-window 24`：

| 指标（n=24） | lexical | deepseek-v4.1-flash | Δ |
|---|---|---|---|
| R@1 | 10.42% | 30.90% | +20.48 |
| R@2 | 19.79% | 35.42% | +15.63 |
| R@5 | 32.78% | 40.28% | +7.50 |
| R@10 | 46.94% | 49.38% | +2.44 |
| MRR@10 | 0.2667 | **0.5152** | +0.2485 |
| multihop R@10 | 15.28% | 23.61% | +8.33 |
| fact / troubleshoot / confusable R@10 | 50.00 / 75.00 / 47.50 | 50.00 / 75.00 / 48.89 | ~0 |
| zh / en R@10 | 31.25 / 62.64 | 39.86 / 58.89 | +8.61 / −3.75 |

读法：语义打分主要买到了**精度**（R@1 翻三倍、MRR 翻倍），多跳的尾部召回只涨 2.4pp——因为窗口 24 限制了它能重排的范围，也因为它仍是在「已经召回的候选」里挑。中文涨、英文略降，说明模型偏好与词法排序并不总一致。

代价：单题平均 **71.9 s**、p95 113 s（2 轮 × 每轮一次 24 候选请求，含偶发重试），全量 100 题约 2 小时。这只能做离线评测，不能进交互路径；成本按 Go 定价约 0.05 美元/24 题。

实现上补了两处必要的工程细节：OpenCode Go 需要 `x-opencode-session`；模型偶尔会漏掉一两个 passage ID，shim 只对漏掉的 ID 重问（最多 3 次），仍不齐则退出码 3——不静默补 0。

顺带修掉一个打包 bug：`dist/bkagent-knowledge.mjs` 里 `import.meta.url` 上溯两级会让默认索引落到 `/home/roy/var/knowledge.sqlite`。改为向上寻找 `pnpm-workspace.yaml`，源码态与 bundle 态解析到同一个 workspace 根，并加了回归测试。

## 9. llm-wiki 同步

PG 领域知识同时在两个地方积累：`llm-wiki` 的 `postgresql-backup-recovery` topic（25+ 篇编译条目，带证据分级）和这里的 SAG2 证据库（原文 passage，用于 `kb_search`）。同步方向是 **wiki → 证据库**：

- wiki 是**事实源**，条目经过交叉核对与 A/B/C 分级；hub 在 `/root/work/llm-wiki`，本仓库无权读写，只能经 llm-wiki MCP 访问。
- 证据库接收它的**摘要视图**：`knowledge-corpus/wiki/<slug>.md`，frontmatter 带 `origin: wiki` 与 `url: llm-wiki://<topic>/wiki/<category>/<slug>.md` 指回原条目。
- 摘要是派生物（与索引同理）：原条目更新后重新导出，不在这里二次编辑。

为什么放独立目录而不是混进上游快照：`knowledge-corpus/manifest.json` 的语义是「抓了什么、何时抓的」，wiki 摘要不是抓取产物。`src/corpus/sources.ts` 分别读 `knowledge-corpus/*.md`（快照）与 `knowledge-corpus/wiki/*.md`（摘要），passage 上打 `origin`，便于按来源过滤或排查。

本轮同步两篇：`pg-archiver-health-evidence-set`（归档健康证据集）与 `pg-wal-naming-and-lsn-arithmetic`（WAL 段命名与 LSN 换算）。索引从 22 源 / 1,514 passage 变为 24 源 / 1,530 passage（建库 321 ms，3.2 MiB）。

代价要说清：**同一批 100 题，R@10 从 48.27% 降到 47.04%**（MRR 0.3405 → 0.3220）。原因是摘要重述了主文档里的同一批事实，在词法检索里形成近重复干扰项。这不是 bug，是「知识更多、精确率略降」的取舍；补了 8 道针对同步内容的题后，108 题口径为 **R@10 50.03%、multihop 27.38%**——覆盖到了新知识，但两套题集不可直接比较。

如果只需要原快照口径，把 `knowledge-corpus/wiki/` 移开再 `index` 即可。

### 9.1 证据分层（2026-11-12 追加）

把 wiki 的**一手摘录**（`raw-*.md`，英文原文引用 + 检索记录）也同步进来后，三种组合实测（108 题）：

| 组合 | 源 / passage | R@10 | multihop R@10 |
|---|---|---|---|
| 仅摘要（`pg-*.md`） | 24 / 1,530 | **50.03%** | 27.38% |
| 摘要 + 原文（全部） | 27 / 1,551 | 48.85% | 23.81% |
| 仅原文（`raw-*.md`） | 25 / 1,537 | 43.76% | 22.02% |

原因很直接：原文是英文引文，而题面用的是摘要里的中文措辞；两边混排时原文既拿不到分，又占位。所以引入 **tier**：`passage.tier` 取 `primary` / `evidence`，`search()` 默认只排 `primary`，`--include-evidence` 才把原文放进候选。

落地后的默认口径回到 **R@10 50.01%**（相对 50.03% 的差异来自 passage ID 变化后的次序 tie-break），`--include-evidence` 为 48.85%——原文随时可查，但不再稀释排序。schema 升到 v3。

2026-11-18 复核：目标闭环文档与故障目录新增条目（A-09–A-13）落地后重建索引，108 题口径为 **R@10 49.08%、MRR@10 0.3354**（`pnpm --filter @backup-agent/knowledge eval --questions eval/questions.jsonl`）。文档即语料：改文档就会动这个数字，引用时必须连同测量日期一起引。

## 10. 结论

1. **增益主要来自扩展，而不是逐轮重排**：`sag2` r2 48.27% 对 `expand-only` 47.13%，逐轮重选只贡献 +1.14pp。论文里这一档差距是 86.62% vs 61.34%——差别在于 JEV 是语义判定，而我们的代理打分器只会算词面覆盖。**结论是打分器而非循环结构才是瓶颈**，继续加轮次不会有收益（r3 与 r2 完全相同，只多 26 ms）。
2. **MMR 在这个语料上是有害的**（48.27% → 43.69%）：本章题集的 gold 经常是同一 section 的多段近重复（故障目录一行一段、命令选项每组一段），多样性惩罚把正确答案挤出了 top-k。默认关闭，`--diversify on` 保留作对照。这是与论文相反的结果，原因是评测单元不同，不是实现错误。
3. **别名词典的收益保持住且跨模式稳定**：bm25 41.94% → sag2 48.27%，zh 46.67% / en 49.87%，中英差距 3.2pp。扩展词没有在更多候选里被稀释。
4. **多跳仍是最弱的一类（23.72%）**：跨段证据需要「A 段的术语送回 B 段检索」，词面扩展只能做到一步；再往上要么加语义重排（P3 本地 reranker / JEV），要么改评测单元。
5. **延迟完全可接受**：p50 46 ms、p95 65 ms，单机、无模型。论文中 SAG v1 的单查询 18.67 s 在这里是另一个量级。
6. **gold 保持小集合**（当前 108 题口径平均 2.73、最多 13）：早期版本一个术语命中 58 个 passage，指标不可解释；现在用 `heading` + `contains` 或 `passage` 精确固定。

## 11. 下一步

| 顺位 | 动作 | 验收 |
|---|---|---|
| P3 | 真模型接入：本地 reranker 权重 + shim（`--scorer command`）或 JEV 端点（`--scorer http`） | multihop R@10 > 23.72%，全量 R@10 ≥ 48.27%；不改变循环结构 |
| P2+ | 扩展词选择加入邻近性（term 与问题词在段内共现距离） | r2 增益 > 1.14pp |
| P1+ | 语料补 `pg_probackup`、WAL-G 的 S3/delete 细节 | 覆盖 provider 差异 |
| P4 | 接 dsh agent 层只读工具（只返回证据+引用） | 已完成 `kb_search`；后续只是参数透传 |

> P3 的端口与契约已完成，并已用 OpenCode Go 的 `deepseek-v4.1-flash` 在 24 题子集上验证（R@1 10.42%→30.90%，MRR 0.2667→0.5152）。JEV 原文口径仍需 OpenRouter 额度；接入时不改 `pipeline.ts`，只换 `--scorer`。
