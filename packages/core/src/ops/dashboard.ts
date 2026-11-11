import type { OpsReport } from './report'

export interface DashboardArtifact {
  id: string
  provider: string
  kind: string
  createdAt: string
  sizeBytes: number
  verifiedLevel: string | null
  path: string
  targetId: string
  protected: boolean
}

export interface DashboardAttempt {
  state: string
  errorClass?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface DashboardData {
  generatedAt: string
  report: OpsReport
  artifacts: readonly DashboardArtifact[]
  attempts: readonly DashboardAttempt[]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(2)} GiB`
}

function badge(level: string | null): string {
  if (level === null) return '<span class="badge muted">未校验</span>'
  return `<span class="badge ok">${escapeHtml(level)}</span>`
}

/**
 * Self-contained, read-only dashboard. No external assets and no credentials;
 * every field is HTML-escaped before interpolation.
 */
export function renderDashboard(data: DashboardData): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
  const rows = data.artifacts
    .map((artifact) => {
      const verified = artifact.verifiedLevel === null ? 'no' : 'yes'
      return `<tr data-provider="${escapeHtml(artifact.provider)}" data-kind="${escapeHtml(
        artifact.kind,
      )}" data-verified="${verified}">
        <td class="mono">${escapeHtml(artifact.createdAt)}</td>
        <td>${escapeHtml(artifact.provider)} / ${escapeHtml(artifact.kind)}</td>
        <td class="mono">${escapeHtml(artifact.targetId)}</td>
        <td class="num">${bytes(artifact.sizeBytes)}</td>
        <td>${badge(artifact.verifiedLevel)}</td>
        <td class="mono path">${escapeHtml(artifact.path)}</td>
      </tr>`
    })
    .join('\n')

  const attemptRows = data.attempts
    .slice()
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? '').localeCompare(a.finishedAt ?? a.startedAt ?? ''))
    .slice(0, 20)
    .map(
      (attempt) => `<tr>
        <td class="mono">${escapeHtml(attempt.finishedAt ?? attempt.startedAt ?? '')}</td>
        <td>${escapeHtml(attempt.state)}</td>
        <td>${escapeHtml(attempt.errorClass ?? '')}</td>
      </tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>backup-agent dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8; --panel: #ffffff; --fg: #16181d; --muted: #6b7280;
    --border: #e5e7eb; --accent: #2563eb; --ok: #067647; --warn: #b54708;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1115; --panel: #171a21; --fg: #e6e8ee; --muted: #9aa3b2;
      --border: #2a2f3a; --accent: #6ea8fe; --ok: #4ade80; --warn: #fbbf24; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { padding: 24px 28px 8px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; }
  main { padding: 16px 28px 40px; display: grid; gap: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .panel h2 { font-size: 15px; margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  select, input { background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 8px; font: inherit; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  tbody tr:last-child td { border-bottom: 0; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .path { max-width: 320px; overflow-wrap: anywhere; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
  .badge.ok { color: var(--ok); border: 1px solid currentColor; }
  .badge.muted { color: var(--muted); border: 1px solid var(--border); }
  .empty { padding: 20px 16px; color: var(--muted); }
  @media (max-width: 720px) { .path { display: none; } th:nth-child(6) { display: none; } }
</style>
</head>
<body>
<header>
  <h1>PostgreSQL 备份与恢复</h1>
  <div class="sub">只读面板 · 生成于 ${escapeHtml(data.generatedAt)}</div>
</header>
<main>
  <section class="cards">
    <div class="card"><div class="label">产物</div><div class="value">${data.report.artifacts}</div></div>
    <div class="card"><div class="label">总容量</div><div class="value">${bytes(data.report.totalBytes)}</div></div>
    <div class="card"><div class="label">校验率</div><div class="value">${percent(data.report.verificationRate)}</div></div>
    <div class="card"><div class="label">失败率</div><div class="value">${percent(data.report.failureRate)}</div></div>
    <div class="card"><div class="label">最近产物</div><div class="value mono">${escapeHtml(data.report.lastArtifactAt ?? '—')}</div></div>
  </section>

  <section class="panel">
    <h2>备份产物（恢复点）</h2>
    <div class="toolbar">
      <select id="provider"><option value="">全部 provider</option>${[
        ...new Set(data.artifacts.map((artifact) => artifact.provider)),
      ]
        .map((provider) => `<option>${escapeHtml(provider)}</option>`)
        .join('')}</select>
      <select id="kind"><option value="">全部类型</option>${[
        ...new Set(data.artifacts.map((artifact) => artifact.kind)),
      ]
        .map((kind) => `<option>${escapeHtml(kind)}</option>`)
        .join('')}</select>
      <select id="verified"><option value="">校验状态</option><option value="yes">已校验</option><option value="no">未校验</option></select>
      <input id="search" placeholder="搜索目标或路径">
    </div>
    ${
      data.artifacts.length === 0
        ? '<div class="empty">尚无产物。执行一次备份并写入控制库后刷新。</div>'
        : `<div style="overflow-x:auto"><table>
      <thead><tr><th>时间</th><th>Provider / 类型</th><th>目标</th><th class="num">大小</th><th>校验</th><th>路径</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
    }
  </section>

  <section class="panel">
    <h2>最近执行</h2>
    ${
      data.attempts.length === 0
        ? '<div class="empty">暂无执行记录。</div>'
        : `<table><thead><tr><th>完成时间</th><th>状态</th><th>错误分类</th></tr></thead>
      <tbody>${attemptRows}</tbody></table>`
    }
  </section>
</main>
<script>
  const rows = Array.from(document.querySelectorAll('tbody tr[data-provider]'));
  const provider = document.getElementById('provider');
  const kind = document.getElementById('kind');
  const verified = document.getElementById('verified');
  const search = document.getElementById('search');
  function apply() {
    const q = (search.value || '').toLowerCase();
    for (const row of rows) {
      const matches = (!provider.value || row.dataset.provider === provider.value)
        && (!kind.value || row.dataset.kind === kind.value)
        && (!verified.value || row.dataset.verified === verified.value)
        && (!q || row.textContent.toLowerCase().includes(q));
      row.hidden = !matches;
    }
  }
  for (const el of [provider, kind, verified]) el.addEventListener('change', apply);
  search.addEventListener('input', apply);
</script>
</body>
</html>
`
}
