# @backup-agent/knowledge

PostgreSQL 备份恢复**证据检索**：SAG2 形态（SQLite FTS5 + BM25，查询时组装关联），零 embedding、零建库模型调用。本包只返回 passage 与引用，不生成结论——解释与决策属于智能体层与 core。

## 定位

- 开发/运维期的文档问答与排障导航，**不参与运行期 Plan 生成**（`ADR-010`：故障目录是编译期输入，运行期不做自由检索）。
- 所有阶段确定性、可离线复现：无 GPU、无外部 API、无 embedding。
- 索引是派生物：语料变了就重建，引用一律回指 `source#ordinal` 与原文路径。

## 命令

```bash
pnpm --filter @backup-agent/knowledge fetch-corpus   # 刷新 knowledge-corpus/（网络）
pnpm --filter @backup-agent/knowledge index          # 建索引 → var/knowledge.sqlite
pnpm --filter @backup-agent/knowledge stats          # meta + 每个来源的 passage 数
pnpm --filter @backup-agent/knowledge ask "归档失败后 PITR 窗口怎么断的" --k 5     # default: sag2, 2 rounds
pnpm --filter @backup-agent/knowledge ask "why does archive_command matter" --json --source pg16-continuous-archiving
pnpm --filter @backup-agent/knowledge ask "归档失败" --expand none      # 消融：关掉别名词典
pnpm --filter @backup-agent/knowledge eval --json /tmp/eval.json
pnpm --filter @backup-agent/knowledge eval --expand none --json /tmp/eval-none.json
pnpm --filter @backup-agent/knowledge eval --mode bm25          # 单轮基线
pnpm --filter @backup-agent/knowledge eval --mode expand-only   # 对照：只扩词、最后打一次分
pnpm --filter @backup-agent/knowledge eval --mode sag2 --rounds 2 --diversify off
pnpm --filter @backup-agent/knowledge scorer --scorer command --scorer-arg python3 --scorer-arg rerank.py
pnpm --filter @backup-agent/knowledge ask "归档失败" --scorer http --scorer-url http://127.0.0.1:8080/score --scorer-key-env JEV_API_KEY
```

`ask` 输出 `sourceId#ordinal [version] headingPath` 与得分，可直接定位到原文段落。

## 语料

`knowledge-corpus/wiki/*.md` 分两层，都在 `origin: wiki` 下：

- `pg-*.md`：条目**摘要视图**（默认 `tier: primary`），与主文档一起参与排序；
- `raw-*.md`：**一手摘录**（`tier: evidence`），入库但**默认不参与排序**——它们是英文原文引用，与摘要/文档重复，实测混排会把 R@10 从 50.01% 拉到 48.85%。需要引用原文时用 `--include-evidence` 或 `--source wikiraw-*` 直接取。


它们是派生物，事实源在 wiki，改内容要改原条目后重新导出。

`knowledge-corpus/*.md` 是**带 frontmatter 的固定快照**（`source_id / url / version / license / fetched_at / sha256 / chars`），`manifest.json` 记录每个来源的状态与哈希。项目内文档（`docs/plan-v1.0.md`、`docs/plan-v1.1.md`、`docs/failure-catalog.md` 及其证据文件）不入快照，按原路径就地读取（`src/corpus/sources.ts` 的 `LOCAL_DOCS`），避免索引与工程师正在编辑的文档漂移。

## 索引与分块

| 项 | 取值 |
|---|---|
| chunk 目标 | 2200 UTF-16 单元，标题变化即切分（`CHUNK_POLICY` 写入 meta） |
| 标题路径 | 拼进 passage 正文首行，BM25 的 `heading_path` 列权重 2.0 |
| 长表格 | ≥8 行时**逐行成 passage**（`列名: 值; …`），因为故障目录一行就是一个事件 |
| 中文 | 索引用 token 串：ASCII 词保持完整，CJK 切成 unigram + bigram，查询侧同样处理 |
| 检索 | 三档：`bm25`（单轮基线）/ `expand-only`（对照）/ `sag2`（默认，2 轮扩展） |
| 打分 | 确定性代理 JEV：问题词覆盖（idf 加权）+ 标识符命中 + 标题命中 + 归一化 BM25；种子选择另加 novelty |
| 多样性 | MMR 默认**关闭**：本语料 gold 常是同一 section 的多段近重复，多样性会挤出正确答案（实测 −4.58pp） |
| 查询改写 | `src/text/aliases.ts` 领域别名词典，只在查询侧追加英文/标识符词；`--expand none` 可关闭做消融 |

pgBackRest 的 HTML 没有 `h1–h6`（用 `div.sectionN-title`），抓取脚本会按 `sectionN → h(N+1)` 合成标题，否则整篇会退化成命令转录。

注意：`CHUNK_POLICY` 或分块代码变化会移动 `ordinal`，`eval/questions.jsonl` 里以 `passage` 固定的 gold 需要重校；优先用 `heading` + `contains` 声明 gold。

## 打分后端

SAG2 的准确率来自「这段证据在当前上下文里是否必要」的判定，论文里由 JEV（模型调用）完成。这里把它做成端口 `src/ports/scorer.ts`：

| 后端 | 说明 |
|---|---|
| `lexical`（默认） | 确定性特征混合：coverage / identifier / heading / lex；离线、零依赖 |
| `command` | 外部进程，argv-only（`shell: false`），stdin 一个 JSON 请求、stdout `{"scores": [...]}` |
| `http` | 批量 POST 同一 JSON 契约；key 只从 `--scorer-key-env` 指定的环境变量读取 |

**fail-closed**：缺 argv、缺 URL、未知后端 → 退出码 2 并说明原因，绝不静默退回 `lexical`。`ask`/`eval` 开跑前先 `health()` 探测，`scorer` 子命令可单独探。

命令后端的最小 shim（换成任何本地模型都一样）：

```js
// rerank.py 的 JS 等价物：读 stdin 的 {question, context, candidates}，
// 写 stdout 的 {"scores": [每个候选一个数]}
```

候选里带 `text` 与 `headingPath`，`features` 是 lexical 特征（语义后端可以忽略）。模型接入只换后端，`pipeline.ts` 不动。

## 评测

`eval/questions.jsonl`：108 题，四类（`fact` / `multihop` / `troubleshoot` / `confusable`），中英各 54，gold 平均 2.73 个 passage（当前索引口径；`w01`–`w08` 为同步 wiki 内容后补题）。gold 声明方式：

```json
{"source":"pg16-continuous-archiving","heading":"26.3.1","contains":"archive_command"}
{"source":"pgbr-user-guide","passage":"pgbr-user-guide#67"}
```

`eval` 在 gold 解析到 0 个 passage 时退出码 1 并列出问题——题集坏了要立刻可见，不能静默降分。

基线数字见 [`../../docs/knowledge-baseline.md`](../../docs/knowledge-baseline.md)。
