// Applying a plan's ops to file contents in memory. The same code runs twice: once at
// plan time on copies (to prove nothing is left and nothing is broken) and once in apply.
import { JsonlFile } from './fsx.js'
import { getAt, redact, setAt } from './text.js'
import type { Op } from './types.js'

type LineOp = Exclude<Op, { op: 'delete-file' }>

/** Apply ops to one JSONL file. Field edits first, then element removals, then line deletes. */
export function applyToJsonl(file: JsonlFile, ops: Op[]) {
  const byLine = new Map<number, LineOp[]>()
  for (const op of ops) {
    if (op.op === 'delete-file') throw new Error('delete-file on a JSONL store')
    if (!('line' in op) || op.line === undefined) throw new Error(`${op.op} without a line on a JSONL store`)
    const list = byLine.get(op.line) ?? []
    list.push(op as LineOp)
    byLine.set(op.line, list)
  }
  for (const [line, list] of byLine) {
    if (list.some((o) => o.op === 'delete-entry' || o.op === 'delete-line')) {
      file.remove(line)
      continue
    }
    const entry = file.get(line)
    if (entry === undefined) throw new Error(`line ${line} is not JSON`)
    const spans = new Map<string, Array<{ start: number; end: number; replacement: string }>>()
    for (const o of list) {
      if (o.op === 'redact-span') {
        const p = o.pointer ?? ''
        spans.set(p, [...(spans.get(p) ?? []), { start: o.start, end: o.end, replacement: o.replacement }])
      }
    }
    // Cut spans first: a later set-field may remove the array/object that held them.
    for (const [pointer, list] of spans) {
      const value = getAt(entry, pointer)
      if (typeof value !== 'string') throw new Error(`line ${line}${pointer} is not a string`)
      setAt(entry, pointer, redactAll(value, list))
    }
    for (const o of list) {
      if (o.op === 'set-field' || o.op === 'blank-field') setAt(entry, o.pointer, o.value)
      else if (o.op === 'relink') setAt(entry, o.pointer, o.to)
    }
    const removals = list
      .filter((o): o is Extract<LineOp, { op: 'remove-element' }> => o.op === 'remove-element')
      .map((o) => splitIndex(o.pointer))
      .sort((a, b) => (a.parent === b.parent ? b.index - a.index : a.parent.localeCompare(b.parent)))
    for (const { parent, index } of removals) {
      const arr = getAt(entry, parent)
      if (!Array.isArray(arr)) throw new Error(`line ${line}${parent} is not an array`)
      arr.splice(index, 1)
    }
    file.set(line, entry)
  }
}

/** Apply ops to a plain text file; returns null when the file should be deleted. */
export function applyToText(text: string, ops: Op[]): string | null {
  if (ops.some((o) => o.op === 'delete-file')) return null
  const spans = ops
    .filter((o): o is Extract<Op, { op: 'redact-span' }> => o.op === 'redact-span' && o.line === undefined)
    .map((o) => ({ start: o.start, end: o.end, replacement: o.replacement }))
  let out = spans.length ? redactAll(text, spans) : text
  const dropLines = new Set(ops.filter((o) => o.op === 'delete-line').map((o) => (o as { line: number }).line))
  if (dropLines.size) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    out = out
      .split(/\r?\n/)
      .filter((_, i) => !dropLines.has(i))
      .join(eol)
  }
  return out
}

function redactAll(value: string, spans: Array<{ start: number; end: number; replacement: string }>): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end) throw new Error('overlapping redactions')
  // Replacements may differ per span, so cut right to left.
  let out = value
  for (const s of sorted.reverse()) out = redact(out, [s], s.replacement)
  return out
}

function splitIndex(pointer: string): { parent: string; index: number } {
  const at = pointer.lastIndexOf('/')
  const index = Number(pointer.slice(at + 1))
  if (!Number.isInteger(index)) throw new Error(`${pointer} does not end in an array index`)
  return { parent: pointer.slice(0, at), index }
}
