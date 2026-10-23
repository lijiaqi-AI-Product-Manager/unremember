import { readFileSync } from 'node:fs'
import { readDshLog } from './fsx.js'
import { JsonlFile } from './fsx.js'
import { findSpans, stringLeaves } from './text.js'
import type { Hit, SessionRef, StoreRef } from './types.js'

export interface SemanticConfig {
  baseUrl: string
  apiKey?: string
  model: string
}

export interface SemanticCandidate {
  id: string
  store: StoreRef
  line?: number
  pointer?: string
  /** Text shown to the locator model. */
  text: string
  /** Absolute offset in a plain-text file. */
  absoluteStart?: number
}

export interface SemanticHit {
  store: StoreRef
  line?: number
  pointer?: string
  start?: number
  end?: number
  confidence: number
  reason: string
}

export function semanticConfig(env: NodeJS.ProcessEnv = process.env): SemanticConfig | undefined {
  const baseUrl = env.UNREMEMBER_SEMANTIC_BASE_URL?.trim()
  const model = env.UNREMEMBER_SEMANTIC_MODEL?.trim()
  if (!baseUrl || !model) return undefined
  return {
    baseUrl,
    model,
    apiKey: env.UNREMEMBER_SEMANTIC_API_KEY?.trim() || undefined,
  }
}

export async function semanticLocate(
  session: SessionRef,
  stores: StoreRef[],
  about: string,
  literals: string[] = [],
): Promise<SemanticHit[]> {
  const config = requireConfig()
  const candidates = buildCandidates(stores)
  if (!candidates.length) return []
  const bytes = Buffer.byteLength(candidates.map((c) => c.text).join('\n'), 'utf8')
  if (bytes > 512 * 1024) throw new Error(`semantic 候选文本 ${bytes} bytes 超过 512KB；请缩小 --text 或改用精确匹配`)
  const out: SemanticHit[] = []
  for (let i = 0; i < candidates.length; i += 8) {
    const batch = candidates.slice(i, i + 8)
    const reply = await chat(config, [
      {
        role: 'system',
        content:
          'You are a precise local-transcript locator. Return JSON only. A quote must be copied exactly from the candidate text. Do not invent text.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          target: about || 'the content described by the literal hints',
          literal_hints: literals,
          schema: { hits: [{ id: 'candidate id', quote: 'exact substring', confidence: '0..1' }] },
          candidates: batch.map((c) => ({ id: c.id, text: c.text })),
        }),
      },
    ])
    const parsed = parseJson(reply)
    const hits = Array.isArray(parsed?.hits) ? parsed.hits : []
    for (const raw of hits) {
      const obj = raw as Record<string, unknown>
      const id = typeof obj.id === 'string' ? obj.id : ''
      const quote = typeof obj.quote === 'string' ? obj.quote : ''
      const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.7
      if (!quote || confidence < 0.5) continue
      const candidate = candidates.find((c) => c.id === id)
      if (!candidate) continue
      if (candidate.pointer !== undefined && candidate.line !== undefined) {
        const rawLine = candidateTextFor(session, candidate)
        const leaf = rawLine?.leaves.find((l) => findSpans(l.value, [quote]).length > 0)
        if (!leaf) continue
        const span = findSpans(leaf.value, [quote])[0]
        if (!span) continue
        out.push({ store: candidate.store, line: candidate.line, pointer: leaf.pointer, start: span.start, end: span.end, confidence, reason: 'semantic locator' })
      } else if (candidate.absoluteStart !== undefined) {
        const span = findSpans(candidate.text, [quote])[0]
        if (!span) continue
        out.push({ store: candidate.store, start: candidate.absoluteStart + span.start, end: candidate.absoluteStart + span.end, confidence, reason: 'semantic locator' })
      }
    }
  }
  return out
}

export async function semanticJudge(answer: string, target: string, hints: string[] = []): Promise<boolean> {
  const config = requireConfig()
  const reply = await chat(config, [
    {
      role: 'system',
      content: 'You are a privacy auditor. Decide whether the answer reveals the target. Return JSON only: {"leak":true|false,"reason":"..."}.',
    },
    {
      role: 'user',
      content: JSON.stringify({ target, hints, answer }),
    },
  ])
  const parsed = parseJson(reply)
  return parsed?.leak === true
}

function requireConfig(): SemanticConfig {
  const config = semanticConfig()
  if (!config) {
    throw new Error(
      'semantic 未配置：需要 UNREMEMBER_SEMANTIC_BASE_URL 和 UNREMEMBER_SEMANTIC_MODEL；可选 UNREMEMBER_SEMANTIC_API_KEY',
    )
  }
  return config
}

async function chat(config: SemanticConfig, messages: Array<{ role: string; content: string }>): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model, messages, temperature: 0 }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`semantic provider HTTP ${response.status}`)
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('semantic provider returned no text')
  return content
}

function parseJson(text: string): Record<string, any> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, any>
  } catch {
    return undefined
  }
}

function candidateTextFor(session: SessionRef, candidate: SemanticCandidate): { leaves: Array<{ pointer: string; value: string }> } | undefined {
  if (candidate.line === undefined) return undefined
  let file: JsonlFile
  try {
    file = candidate.store.path.endsWith('.zstd')
      ? new JsonlFile(readDshLog(candidate.store.path))
      : new JsonlFile(readFileSync(candidate.store.path, 'utf8'))
  } catch {
    return undefined
  }
  const entry = file.get(candidate.line)
  if (!entry) return undefined
  return { leaves: [...stringLeaves(entry)].filter((l) => l.value.trim().length > 0) }
}

export function buildCandidates(stores: StoreRef[]): SemanticCandidate[] {
  const out: SemanticCandidate[] = []
  for (const store of stores) {
    let text: string
    try {
      text = store.path.endsWith('.zstd') ? readDshLog(store.path) : readFileSync(store.path, 'utf8')
    } catch {
      continue
    }
    if (store.path.endsWith('.jsonl') || store.path.endsWith('.jsonl.zstd')) {
      const file = new JsonlFile(text)
      for (let line = 0; line < file.length; line++) {
        const entry = file.get(line)
        if (!entry) continue
        const leaves = [...stringLeaves(entry)].filter((leaf) => meaningfulLeaf(leaf.pointer, leaf.value))
        if (!leaves.length) continue
        const body = leaves.map((l) => `${l.pointer}: ${l.value}`).join('\n').slice(0, 5000)
        out.push({ id: `c${out.length}`, store, line, pointer: leaves[0]!.pointer, text: body })
      }
    } else {
      const re = /.*(?:\r?\n|$)/g
      let match: RegExpExecArray | null
      while ((match = re.exec(text)) !== null) {
        const raw = match[0]
        if (!raw) break
        const line = raw.replace(/\r?\n$/, '')
        if (line.trim()) out.push({ id: `c${out.length}`, store, text: line.slice(0, 2000), absoluteStart: match.index })
      }
    }
    if (out.length > 4000) break
  }
  return out
}

function meaningfulLeaf(pointer: string, value: string): boolean {
  if (value.trim().length < 4) return false
  if (/\/(?:type|role|id|uuid|sessionId|cwd|version|timestamp|hash|model|provider)$/.test(pointer)) return false
  return /(?:text|thinking|content|message|lastPrompt|aiTitle|title|summary|rawOutput|arguments|output)/i.test(pointer)
}

export function toHits(semantic: SemanticHit[]): Hit[] {
  return semantic.map((h) => ({
    store: h.store,
    locator: { line: h.line, pointer: h.pointer, start: h.start, end: h.end },
    how: 'semantic',
    confidence: h.confidence,
    reason: h.reason,
  }))
}
