import { describe, expect, it } from 'vitest'
import { riskAtLeast } from '../src/domain/risk'

describe('smoke', () => {
  it('orders risk levels', () => {
    expect(riskAtLeast('destructive', 'reversible')).toBe(true)
    expect(riskAtLeast('read-only', 'reversible')).toBe(false)
  })
})
