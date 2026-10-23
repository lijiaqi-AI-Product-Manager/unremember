import { describe, expect, it } from 'vitest'
import { excerpt, findSpans, getAt, mask, redact, setAt, stringLeaves } from '../src/text.js'

describe('findSpans', () => {
  it('finds a literal secret', () => {
    const s = '记住一个暗号：青柠绿-7429，之后不要主动提起。'
    const [span] = findSpans(s, ['青柠绿-7429'])
    expect(s.slice(span!.start, span!.end)).toBe('青柠绿-7429')
  })

  it('sees through full-width digits, zero-width chars and case', () => {
    const s = 'code: ＡＢ​-７４２９ ok'
    const spans = findSpans(s, ['ab-7429'])
    expect(spans).toHaveLength(1)
    expect(redact(s, spans, '')).toBe('code:  ok')
  })

  it('merges overlapping variants', () => {
    const spans = findSpans('xx 青柠绿-7429 yy', ['青柠绿-7429', '7429'])
    expect(spans).toHaveLength(1)
  })

  it('reports every occurrence', () => {
    expect(findSpans('7429 and 7429', ['7429'])).toHaveLength(2)
  })
})

describe('mask and excerpt', () => {
  it('keeps half of each token', () => {
    expect(mask('青柠绿-7429')).toBe('青柠█-74██')
  })

  it('never shows the full secret', () => {
    const s = '之前说的暗号是青柠绿-7429，别忘了'
    const out = excerpt(s, findSpans(s, ['青柠绿-7429'])[0]!)
    expect(out).not.toContain('7429')
    expect(out).toContain('[青柠█-74██]')
  })
})

describe('JSON pointers', () => {
  const doc = { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b/c' }] }, 'x/y': 'z' }

  it('walks string leaves', () => {
    const leaves = [...stringLeaves(doc)].map((l) => l.pointer)
    expect(leaves).toContain('/message/content/1/text')
    expect(leaves).toContain('/x~1y')
  })

  it('reads and writes', () => {
    const copy = structuredClone(doc)
    setAt(copy, '/message/content/1/text', '')
    expect(getAt(copy, '/message/content/1/text')).toBe('')
    expect(getAt(copy, '/x~1y')).toBe('z')
  })
})
