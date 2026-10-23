import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

export type JsonObject = Record<string, unknown>

export function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function blocksOf(entry: unknown): JsonObject[] {
  const message = asObject(asObject(entry)?.message)
  return asArray(message?.content).filter((v): v is JsonObject => asObject(v) !== undefined)
}

/** Human-readable text in one Claude/dsh message, without exposing tool payloads. */
export function contentText(entry: unknown): string {
  const message = asObject(asObject(entry)?.message)
  const content = message?.content
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of blocksOf(entry)) {
    const text = asString(block.text) ?? asString(block.thinking)
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

export function isToolResult(entry: unknown): boolean {
  return blocksOf(entry).some((block) => block.type === 'tool_result')
}

export function isRealUserPrompt(entry: unknown): boolean {
  const obj = asObject(entry)
  if (!obj || obj.type !== 'user') return false
  if (obj.isCompactSummary === true) return false
  const content = asObject(obj.message)?.content
  if (typeof content === 'string') return content.trim().length > 0
  return blocksOf(entry).some((block) => block.type === 'text' || typeof block.text === 'string') && !isToolResult(entry)
}

export function preview(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function timestampOf(value: unknown): number | undefined {
  const obj = asObject(value)
  if (!obj) return undefined
  const t = obj.timestamp
  if (typeof t === 'number' && Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

export function safeReadText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

export function isTextFile(file: string): boolean {
  return !['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.zst', '.zstd', '.bin', '.db'].includes(
    extname(file).toLowerCase(),
  )
}

/** Recursively list regular files. Missing directories yield an empty list. */
export function listFiles(root: string, predicate: (file: string) => boolean = () => true): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const file = join(dir, name)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile() && predicate(file)) out.push(file)
    }
  }
  if (statSync(root, { throwIfNoEntry: false })) walk(root)
  return out
}

export function jsonLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function parseJsonLines(text: string): unknown[] {
  return jsonLines(text).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })
}

export function fingerprintTypes(entries: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    const type = asString(asObject(entry)?.type)
    if (type) counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}
