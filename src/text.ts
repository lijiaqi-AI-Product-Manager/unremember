// Matching that survives the ways a secret gets disguised on disk: full-width forms,
// zero-width characters and case. Spans are reported in the original string's indices so
// a redaction cuts exactly what was matched.

const ZERO_WIDTH = /[​-‍⁠﻿]/

interface Folded {
  text: string
  /** map[i] = index in the original string where folded char i came from; map[text.length] = original length. */
  map: number[]
}

export function fold(input: string): Folded {
  let text = ''
  const map: number[] = []
  let i = 0
  while (i < input.length) {
    const cp = input.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    if (!ZERO_WIDTH.test(ch)) {
      const out = ch.normalize('NFKC').toLowerCase()
      for (let k = 0; k < out.length; k++) map.push(i)
      text += out
    }
    i += ch.length
  }
  map.push(input.length)
  return { text, map }
}

export interface Span {
  start: number
  end: number
  /** Index into the needles list. */
  needle: number
}

/** Every occurrence of any needle, in original indices, sorted and non-overlapping. */
export function findSpans(haystack: string, needles: string[]): Span[] {
  const folded = fold(haystack)
  const spans: Span[] = []
  needles.forEach((needle, n) => {
    const target = fold(needle).text
    if (!target) return
    let from = 0
    for (;;) {
      const at = folded.text.indexOf(target, from)
      if (at < 0) break
      // End just past the original character that produced the last matched folded char.
      const lastOrig = folded.map[at + target.length - 1]!
      const end = lastOrig + String.fromCodePoint(haystack.codePointAt(lastOrig)!).length
      spans.push({ start: folded.map[at]!, end, needle: n })
      from = at + 1
    }
  })
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Span[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  return merged
}

export function redact(input: string, spans: Array<{ start: number; end: number }>, replacement = ''): string {
  let out = ''
  let at = 0
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    out += input.slice(at, s.start) + replacement
    at = s.end
  }
  return out + input.slice(at)
}

/** Show enough of a secret to recognise it, not enough to recover it: 青柠绿-7429 -> 青柠█-74██ */
export function mask(secret: string): string {
  return secret.replace(/[\p{L}\p{N}]+/gu, (token) => {
    const chars = [...token]
    const keep = Math.ceil(chars.length / 2)
    return chars.slice(0, keep).join('') + '█'.repeat(chars.length - keep)
  })
}

export function excerpt(input: string, span: { start: number; end: number }, radius = 24): string {
  const left = input.slice(Math.max(0, span.start - radius), span.start)
  const right = input.slice(span.end, span.end + radius)
  const oneLine = (s: string) => s.replace(/\s+/g, ' ')
  return `${span.start > radius ? '…' : ''}${oneLine(left)}[${mask(input.slice(span.start, span.end))}]${oneLine(right)}${span.end + radius < input.length ? '…' : ''}`
}

// ---- JSON pointers (RFC 6901) ----

const escapeToken = (t: string) => t.replace(/~/g, '~0').replace(/\//g, '~1')
const unescapeToken = (t: string) => t.replace(/~1/g, '/').replace(/~0/g, '~')

/** Every string leaf under `value`, with its JSON pointer. */
export function* stringLeaves(value: unknown, pointer = ''): Generator<{ pointer: string; value: string }> {
  if (typeof value === 'string') {
    yield { pointer, value }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* stringLeaves(value[i], `${pointer}/${i}`)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* stringLeaves(v, `${pointer}/${escapeToken(k)}`)
  }
}

export function getAt(root: unknown, pointer: string): unknown {
  if (pointer === '') return root
  let cur: any = root
  for (const token of pointer.slice(1).split('/').map(unescapeToken)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[token]
  }
  return cur
}

export function setAt(root: unknown, pointer: string, value: unknown) {
  if (pointer === '') throw new Error('cannot replace the root')
  const tokens = pointer.slice(1).split('/').map(unescapeToken)
  const last = tokens.pop()!
  const parent: any = getAt(root, tokens.length ? '/' + tokens.map(escapeToken).join('/') : '')
  if (parent === null || typeof parent !== 'object') throw new Error(`no parent for ${pointer}`)
  parent[last] = value
}
