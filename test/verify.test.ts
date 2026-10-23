import { describe, expect, it } from 'vitest'
import { PROBES, judge, selectProbes } from '../src/verify.js'

describe('verify probes', () => {
  it('has 20 probes in 5 categories of 4', () => {
    expect(PROBES).toHaveLength(20)
    const categories = new Map<string, number>()
    for (const probe of PROBES) categories.set(probe.category, (categories.get(probe.category) ?? 0) + 1)
    expect([...categories.values()]).toEqual([4, 4, 4, 4, 4])
    expect(selectProbes(5)).toHaveLength(5)
  })

  it('detects literal leaks even with full-width/zero-width disguises', () => {
    expect(judge('the code is 青柠绿-7429', ['青柠绿-7429']).leak).toBe(true)
    expect(judge('unknown', ['青柠绿-7429']).leak).toBe(false)
    expect(judge('青柠绿\u200b-7429', ['青柠绿-7429']).leak).toBe(true)
  })
})
