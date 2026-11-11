/**
 * Domain term aliases for cross-lingual lexical retrieval.
 *
 * The corpus is overwhelmingly English; questions are often Chinese. BM25 over
 * CJK bigrams cannot match `archive_command` from "归档命令", so the query is
 * rewritten by appending the English terms an engineer would have typed.
 *
 * Rules that keep this honest:
 * - Query-side only. The index stays a verbatim snapshot, so nothing here can
 *   change what a passage *says*.
 * - Longest match wins, matched spans are consumed, so "时间点恢复" does not also
 *   fire "恢复"/"时间".
 * - Expansions must be high precision. A wrong expansion costs recall on every
 *   question, not just this one.
 */

export interface AliasEntry {
  /** Surface forms matched against the lowercased query. */
  terms: string[]
  /** English/identifier forms appended to the query. */
  expand: string[]
}

export const ALIASES: AliasEntry[] = [
  // --- archiving ---
  { terms: ['归档命令', '归档参数'], expand: ['archive_command', 'archive'] },
  { terms: ['归档失败', '归档中断'], expand: ['archive_command', 'archiver', 'failed_count'] },
  { terms: ['归档', '归档的'], expand: ['archive', 'archiving', 'archive_command'] },
  { terms: ['异步归档'], expand: ['archive-async', 'asynchronous archiving'] },
  { terms: ['归档状态'], expand: ['archive_status', 'archived_count'] },
  { terms: ['未归档'], expand: ['archive', 'wal'] },
  { terms: ['年假'], expand: [] },
  // --- recovery ---
  { terms: ['时间点恢复', '按时间点'], expand: ['point-in-time recovery', 'recovery_target_time'] },
  { terms: ['恢复到某个时刻', '恢复到指定时间'], expand: ['recovery_target_time', 'recovery'] },
  { terms: ['恢复目标'], expand: ['recovery_target'] },
  { terms: ['恢复点', '恢复位置'], expand: ['recovery_target', 'restore point'] },
  { terms: ['恢复命令'], expand: ['restore_command', 'restore'] },
  { terms: ['恢复窗口', '可恢复窗口'], expand: ['recoverable window', 'recovery', 'archive'] },
  { terms: ['不可恢复', '无法恢复'], expand: ['recovery', 'failed'] },
  { terms: ['恢复', '还原'], expand: ['restore', 'recovery'] },
  { terms: ['崩溃恢复'], expand: ['crash recovery', 'crash-safety'] },
  { terms: ['回放', '重放'], expand: ['replay'] },
  { terms: ['时间线'], expand: ['timeline'] },
  { terms: ['历史文件'], expand: ['history file', 'timeline'] },
  // --- backup kinds ---
  { terms: ['基础备份', '全量备份'], expand: ['base backup', 'full backup'] },
  { terms: ['增量备份'], expand: ['incremental', 'incremental backup'] },
  { terms: ['差异备份'], expand: ['differential', 'differential backup'] },
  { terms: ['备份链'], expand: ['incremental', 'differential', 'chain'] },
  { terms: ['逻辑备份', '逻辑导出'], expand: ['pg_dump', 'logical'] },
  { terms: ['物理备份'], expand: ['base backup', 'physical'] },
  { terms: ['备份集', '备份仓库'], expand: ['repository', 'stanza'] },
  { terms: ['备份'], expand: ['backup'] },
  { terms: ['导出'], expand: ['dump', 'pg_dump'] },
  { terms: ['转储'], expand: ['dump'] },
  { terms: ['自定义格式'], expand: ['custom', 'format'] },
  { terms: ['目录格式'], expand: ['directory', 'format'] },
  { terms: ['并行'], expand: ['jobs', 'parallel'] },
  { terms: ['快照'], expand: ['snapshot'] },
  // --- wal / lsn ---
  { terms: ['预写日志', '写前日志'], expand: ['write ahead log', 'wal'] },
  { terms: ['日志序列号', '日志序列'], expand: ['lsn', 'log sequence number'] },
  { terms: ['检查点'], expand: ['checkpoint'] },
  { terms: ['段'], expand: ['segment'] },
  { terms: ['缺口'], expand: ['gap', 'missing'] },
  { terms: ['膨胀'], expand: ['bloat', 'grow', 'retention'] },
  { terms: ['回收'], expand: ['recycle', 'recycle wal', 'retention'] },
  { terms: ['复制槽'], expand: ['replication slot', 'restart_lsn'] },
  { terms: ['备库', '备机', '从库'], expand: ['standby', 'replica'] },
  { terms: ['主库'], expand: ['primary'] },
  // --- verification ---
  { terms: ['校验', '验证'], expand: ['verify', 'verification', 'checksum'] },
  { terms: ['备份清单', '清单文件'], expand: ['backup_manifest', 'manifest'] },
  { terms: ['页校验和'], expand: ['checksum', 'full_page_writes'] },
  { terms: ['已验证恢复点'], expand: ['verified restore point', 'vrp'] },
  // --- operations / catalog ---
  { terms: ['预检'], expand: ['precheck'] },
  { terms: ['故障目录', '故障模式'], expand: ['failure catalog', 'failure mode'] },
  { terms: ['可观测签名', '报错签名'], expand: ['signature', 'error'] },
  { terms: ['保留期', '保留策略'], expand: ['retention', 'expire', 'retain'] },
  { terms: ['过期'], expand: ['expire', 'retention'] },
  { terms: ['清理'], expand: ['delete', 'prune', 'expire'] },
  { terms: ['双人复核', '审批'], expand: ['approval', 'mandate'] },
  { terms: ['审计'], expand: ['audit'] },
  { terms: ['凭据', '密钥'], expand: ['secret', 'credential', 'secretref'] },
  { terms: ['租约'], expand: ['lease', 'fencing token'] },
  { terms: ['幂等'], expand: ['idempotency', 'idempotencykey'] },
  { terms: ['事务'], expand: ['transaction'] },
  { terms: ['产物'], expand: ['artifact'] },
  { terms: ['目标实例'], expand: ['target', 'instance'] },
  // --- error symptoms ---
  { terms: ['磁盘写满', '空间不足', '磁盘满'], expand: ['no space left on device', 'disk'] },
  { terms: ['连接数'], expand: ['too many clients', 'connections'] },
  { terms: ['权限不足', '没有权限'], expand: ['permission denied'] },
  { terms: ['认证失败', '密码错误'], expand: ['password authentication failed'] },
  { terms: ['超时'], expand: ['timeout'] },
  { terms: ['锁等待'], expand: ['lock wait', 'statement timeout'] },
  { terms: ['版本不匹配', '版本不一致'], expand: ['version', 'unsupported version'] },
  { terms: ['属主'], expand: ['owner', 'role'] },
  { terms: ['角色不存在'], expand: ['role', 'does not exist'] },
  { terms: ['表空间'], expand: ['tablespace'] },
  { terms: ['长事务'], expand: ['long transaction', 'xact_start'] },
  // --- identifiers engineers type in Chinese contexts ---
  { terms: ['统计视图'], expand: ['pg_stat', 'view'] },
  { terms: ['归档统计'], expand: ['pg_stat_archiver'] },
  { terms: ['复制统计'], expand: ['pg_stat_replication'] },
  { terms: ['进程活动'], expand: ['pg_stat_activity'] },
  { terms: ['基础备份工具'], expand: ['pg_basebackup'] },
]

/** English surface forms that should also expand (synonyms and abbreviations). */
const ENGLISH_ALIASES: AliasEntry[] = [
  { terms: ['pitr'], expand: ['point-in-time', 'recovery'] },
  { terms: ['wal'], expand: ['write ahead log'] },
  { terms: ['lsn'], expand: ['log sequence number'] },
  { terms: ['basebackup', 'base-backup'], expand: ['base backup', 'pg_basebackup'] },
  { terms: ['archiver'], expand: ['archive_command', 'archive'] },
  { terms: ['vrp'], expand: ['verified restore point'] },
  { terms: ['repo'], expand: ['repository', 'stanza'] },
  { terms: ['slot'], expand: ['replication slot'] },
  { terms: ['retention'], expand: ['expire', 'retain'] },
  { terms: ['tablespace'], expand: ['directory', 'restore'] },
]

const ALL_ENTRIES = [...ALIASES, ...ENGLISH_ALIASES].map((entry) => ({
  ...entry,
  terms: entry.terms.map((term) => term.toLowerCase()),
}))

// Longest surface form first, so "时间点恢复" wins over "恢复".
const SORTED = [...ALL_ENTRIES].sort(
  (a, b) => Math.max(...b.terms.map((term) => term.length)) - Math.max(...a.terms.map((term) => term.length)),
)

export interface ExpansionResult {
  /** Original question with appended expansions, ready for tokenization. */
  query: string
  /** Surface forms that fired, for debugging and for the eval log. */
  applied: string[]
  /** Expansion terms actually appended. */
  added: string[]
}

export function expandQuery(question: string, options: { enabled?: boolean } = {}): ExpansionResult {
  if (options.enabled === false) return { query: question, applied: [], added: [] }

  const haystack = question.toLowerCase()
  const consumed = new Uint8Array(haystack.length)
  const applied: string[] = []
  const added: string[] = []

  for (const entry of SORTED) {
    for (const term of entry.terms) {
      if (term.length === 0) continue
      let from = 0
      for (;;) {
        const at = haystack.indexOf(term, from)
        if (at === -1) break
        from = at + 1
        let free = true
        for (let index = at; index < at + term.length; index += 1) {
          if (consumed[index] === 1) {
            free = false
            break
          }
        }
        if (!free) continue
        for (let index = at; index < at + term.length; index += 1) consumed[index] = 1
        applied.push(term)
        for (const expansion of entry.expand) added.push(expansion)
      }
    }
  }

  const unique = [...new Set(added)]
  if (unique.length === 0) return { query: question, applied, added: [] }
  return { query: `${question} ${unique.join(' ')}`, applied, added: unique }
}
