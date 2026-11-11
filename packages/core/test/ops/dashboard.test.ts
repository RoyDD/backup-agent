import { describe, expect, it } from 'vitest'

import { renderDashboard } from '../../src/ops/dashboard'
import { buildOpsReport } from '../../src/ops/report'

const since = '2026-01-01T00:00:00.000Z'
const now = '2026-02-01T00:00:00.000Z'

describe('renderDashboard', () => {
  it('renders artifacts, verification and summary cards', () => {
    const artifacts = [
      {
        id: 'art_1',
        provider: 'native-logical',
        kind: 'logical',
        createdAt: '2026-01-31T00:00:00.000Z',
        sizeBytes: 1024,
        verifiedLevel: 'V1',
        path: '/tmp/<script>alert(1)</script>.dump',
        targetId: 'pg:5432/app',
        protected: false,
      },
    ]
    const report = buildOpsReport({
      since,
      now,
      artifacts,
      attempts: [{ state: 'succeeded' }],
    })
    const html = renderDashboard({ generatedAt: now, report, artifacts, attempts: [] })

    expect(html).toContain('native-logical')
    expect(html).toContain('logical')
    expect(html).toContain('V1')
    expect(html).toContain('1.0 KiB')
    expect(html).toContain('100.0%')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('shows empty states without any artifact', () => {
    const report = buildOpsReport({ since, now, artifacts: [], attempts: [] })
    const html = renderDashboard({ generatedAt: now, report, artifacts: [], attempts: [] })
    expect(html).toContain('尚无产物')
    expect(html).toContain('暂无执行记录')
  })
})
