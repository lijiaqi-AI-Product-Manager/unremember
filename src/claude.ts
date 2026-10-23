import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { JsonlFile, sha256File } from './fsx.js'
import { applyToJsonl, applyToText } from './ops.js'
import { applyPlanWithLive } from './apply-core.js'
import { Store } from './store.js'
import { claudeConfigDir } from './paths.js'
import { pidAlive } from './proc.js'
import { excerpt, findSpans, getAt, stringLeaves } from './text.js'
import type {
  Adapter,
  FormatFingerprint,
  Hit,
  LiveState,
  Op,
  Plan,
  PlanDraft,
  PlanOptions,
  SessionInfo,
  SessionRef,
  StoreRef,
  Target,
} from './types.js'
import {
  asArray,
  asObject,
  asString,
  blocksOf,
  contentText,
  fingerprintTypes,
  isRealUserPrompt,
  isTextFile,
  isToolResult,
  jsonLines,
  listFiles,
  parseJsonLines,
  preview,
  safeReadText,
  timestampOf,
} from './util.js'

/** Claude entry types this build understands. Unknown ones are scanned but block apply on a hit. */
export const CLAUDE_TYPES = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'last-prompt',
  'ai-title',
  'mode',
  'permission-mode',
  'atis-latch',
  'file-history-snapshot',
  'file-history-delta',
  'cost-state',
  'queue-operation',
  'summary',
])

interface Candidate {
  file: string
  kind: StoreRef['kind']
  line?: number
  entry?: unknown
  pointer?: string
  start?: number
  end?: number
  text: string
}

interface OpsResult {
  ops: Op[]
  blockers: string[]
}

export class ClaudeAdapter implements Adapter {
  readonly platform = 'claude-code' as const
  readonly root: string

  constructor(root = claudeConfigDir()) {
    this.root = resolve(root)
  }

  private projectsDir() {
    return join(this.root, 'projects')
  }

  private sessionsDir() {
    return join(this.root, 'sessions')
  }

  listSessions(options: { cwd?: string } = {}): SessionInfo[] {
    const out: SessionInfo[] = []
    for (const file of listFiles(this.projectsDir(), (f) => f.endsWith('.jsonl'))) {
      const relative = file.slice(this.projectsDir().length + 1)
      if (relative.split(/[\\/]/).length < 2) continue
      if (relative.includes(`${'subagents'}${'/'}`) || relative.includes(`${'subagents'}${'\\'}`)) continue
      const info = this.sessionInfo(file)
      if (!info) continue
      if (options.cwd && resolve(options.cwd) !== resolve(info.cwd ?? info.projectDir ?? '')) continue
      out.push(info)
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return out
  }

  resolveSession(query: string, options: { cwd?: string } = {}): SessionRef | undefined {
    const sessions = this.listSessions(options)
    if (query === 'last') {
      const cwd = options.cwd ? resolve(options.cwd) : resolve(process.cwd())
      return sessions.find((s) => (s.cwd ?? s.projectDir) && resolve((s.cwd ?? s.projectDir)!) === cwd) ?? sessions[0]
    }
    const absolute = resolve(query)
    if (absolute.endsWith('.jsonl')) {
      const info = this.sessionInfo(absolute)
      if (info) return info
    }
    const exact = sessions.find((s) => s.sessionId === query)
    if (exact) return exact
    const prefixed = sessions.filter((s) => s.sessionId.startsWith(query))
    if (prefixed.length === 1) return prefixed[0]
    if (prefixed.length > 1) throw new Error(`会话 id 前缀 "${query}" 不唯一`)
    return undefined
  }

  liveState(session: SessionRef): LiveState {
    let names: string[]
    try {
      names = listFiles(this.sessionsDir(), (f) => f.endsWith('.json')).map((f) => basename(f))
    } catch {
      return 'unknown'
    }
    let matched = false
    try {
      for (const name of names) {
        const raw = safeReadText(join(this.sessionsDir(), name))
        if (!raw) continue
        const meta = asObject(JSON.parse(raw))
        if (!meta || asString(meta.sessionId) !== session.sessionId) continue
        matched = true
        const pid = typeof meta.pid === 'number' ? meta.pid : Number(meta.pid)
        if (Number.isInteger(pid) && pidAlive(pid)) return 'live'
      }
      return matched ? 'idle' : 'idle'
    } catch {
      return 'unknown'
    }
  }

  stores(session: SessionRef): StoreRef[] {
    const out: StoreRef[] = [{ kind: 'cc-transcript', path: session.file }]
    const projectDir = session.projectDir ?? dirname(session.file)
    const sessionDir = join(projectDir, session.sessionId)
    const add = (kind: StoreRef['kind'], paths: string[]) => {
      for (const path of paths) out.push({ kind, path })
    }
    add('cc-subagent', listFiles(join(sessionDir, 'subagents'), (f) => f.endsWith('.jsonl')))
    const history = join(this.root, 'history.jsonl')
    if (safeReadText(history) !== undefined) out.push({ kind: 'cc-history', path: history })
    const memory = join(projectDir, 'memory')
    const memFiles = listFiles(memory, (f) => f.endsWith('.md'))
    for (const file of memFiles) out.push({ kind: basename(file) === 'MEMORY.md' ? 'cc-memory-index' : 'cc-memory', path: file })
    add(
      'cc-file-history',
      listFiles(join(this.root, 'file-history', session.sessionId), (f) => isTextFile(f)),
    )
    add(
      'cc-tool-result',
      listFiles(join(sessionDir, 'tool-results'), (f) => isTextFile(f)),
    )
    add(
      'cc-paste-cache',
      listFiles(join(this.root, 'paste-cache'), (f) => isTextFile(f)),
    )
    return out
  }

  async plan(session: SessionRef, target: Target, options: PlanOptions = {}): Promise<{ draft: PlanDraft; hits: Hit[] }> {
    if (target.about && !target.text?.length && !target.messageIds?.length) {
      throw new Error('--about 需要 --semantic；当前构建没有配置语义定位模型')
    }
    const targetTexts = [...(target.text ?? [])].filter((s) => s.length > 0)
    if (!targetTexts.length && !target.messageIds?.length) throw new Error('没有目标文本或 message id')

    const stores = this.stores(session)
    const hits: Hit[] = []
    const explicitLines = new Set<number>()
    const transcript = JsonlFile.read(session.file)
    const entries = Array.from({ length: transcript.length }, (_, i) => transcript.get(i))
    const byUuid = new Map<string, number>()
    entries.forEach((entry, line) => {
      const uuid = asString(asObject(entry)?.uuid)
      if (uuid) byUuid.set(uuid, line)
    })
    for (const id of target.messageIds ?? []) {
      const line = byUuid.get(id)
      if (line === undefined) throw new Error(`在会话里找不到 message/uuid ${id}`)
      explicitLines.add(line)
      hits.push({
        store: { kind: 'cc-transcript', path: session.file },
        locator: { line },
        how: 'dependency',
        confidence: 1,
        excerpt: `[message ${id.slice(0, 8)}…]`,
        reason: 'explicit message id',
      })
    }

    for (const store of stores) {
      const isJsonl = store.path.endsWith('.jsonl')
      if (isJsonl) {
        const file = store.path === session.file ? transcript : JsonlFile.read(store.path)
        for (let line = 0; line < file.length; line++) {
          const entry = file.get(line)
          if (entry === undefined) continue
          if (store.kind === 'cc-history') {
            const o = asObject(entry)
            const sid = asString(o?.sessionId)
            const project = asString(o?.project) ?? asString(o?.cwd)
            if (sid !== undefined && sid !== session.sessionId) continue
            if (sid === undefined && project !== undefined && session.cwd && resolve(project) !== resolve(session.cwd)) continue
          }
          if (targetTexts.length) {
            for (const leaf of stringLeaves(entry)) {
              for (const span of findSpans(leaf.value, targetTexts)) {
                hits.push({
                  store,
                  locator: { line, pointer: leaf.pointer, start: span.start, end: span.end },
                  how: 'exact',
                  confidence: 1,
                  excerpt: excerpt(leaf.value, span),
                })
              }
            }
          }
        }
      } else {
        const text = safeReadText(store.path)
        if (text === undefined) continue
        for (const span of findSpans(text, targetTexts)) {
          hits.push({ store, locator: { start: span.start, end: span.end }, how: 'exact', confidence: 1, excerpt: excerpt(text, span) })
        }
      }
    }

    const fingerprint = this.fingerprint(entries, hits)
    const blockers: string[] = []
    if (!Object.keys(fingerprint.entryTypes).some((t) => t === 'user' || t === 'assistant')) blockers.push('没有识别到 user/assistant 结构，拒绝执行')
    if (fingerprint.unknownTypes.some((type) => hits.some((h) => asString(asObject(entries[h.locator.line ?? -1])?.type) === type))) {
      blockers.push('命中落在未知条目类型上；格式可能变了，拒绝执行')
    }

    const ops: Op[] = []
    const byPath = new Map<string, Hit[]>()
    for (const hit of hits) {
      const list = byPath.get(hit.store.path) ?? []
      list.push(hit)
      byPath.set(hit.store.path, list)
    }
    for (const store of stores) {
      const storeHits = byPath.get(store.path)
      if (!storeHits?.length) continue
      if (store.kind === 'cc-transcript' || store.kind === 'cc-subagent') {
        const file = store.path === session.file ? transcript : JsonlFile.read(store.path)
        const result = this.transcriptOps(store, file, storeHits, store.kind === 'cc-transcript' ? explicitLines : new Set(), options.scope ?? 'turn')
        ops.push(...result.ops)
        blockers.push(...result.blockers)
      } else if (store.kind === 'cc-history') {
        ops.push(...this.historyOps(store, storeHits, session))
      } else if (store.kind === 'cc-memory-index' || store.kind === 'cc-memory') {
        ops.push(...this.memoryOps(store, storeHits, targetTexts))
      } else {
        ops.push(...this.textOps(store, storeHits))
      }
    }

    // Deleting a dedicated memory file must also remove its index line from MEMORY.md.
    for (const op of [...ops]) {
      if (op.op !== 'delete-file' || op.store.kind !== 'cc-memory') continue
      const indexPath = join(dirname(op.store.path), 'MEMORY.md')
      const indexText = safeReadText(indexPath)
      if (indexText === undefined) continue
      const base = basename(op.store.path)
      const indexLines = jsonLines(indexText)
      for (let line = 0; line < indexLines.length; line++) {
        if (!indexLines[line]!.includes(base)) continue
        if (!ops.some((o) => o.op === 'delete-line' && o.store.path === indexPath && o.line === line)) {
          ops.push({ op: 'delete-line', store: { kind: 'cc-memory-index', path: indexPath }, line, reason: '从 memory 索引移除已删文件' })
        }
      }
    }

    const touched = [...new Set(ops.filter((o) => o.op !== 'delete-file').map((o) => o.store.path))]
    const deletedFiles = [...new Set(ops.filter((o) => o.op === 'delete-file').map((o) => o.store.path))]
    const files = [...touched, ...deletedFiles]
      .map((path) => ({ path, sha256Before: sha256File(path) }))
      .filter((f, i, a) => a.findIndex((x) => x.path === f.path) === i)

    const residualHits = this.residual(ops, stores, targetTexts, session)
    if (residualHits > 0) blockers.push(`模拟执行后仍残留 ${residualHits} 处精确命中`)
    if (session.platform !== 'claude-code') throw new Error('adapter/session platform mismatch')

    return {
      draft: {
        session,
        fingerprint,
        ops,
        files,
        warnings: [],
        blockers: [...new Set(blockers)],
        residualHits,
      },
      hits,
    }
  }

  apply(plan: Plan): void {
    applyPlanWithLive(plan, new Store(), (session) => this.liveState(session))
  }

  private sessionInfo(file: string): SessionInfo | undefined {
    const text = safeReadText(file)
    if (!text) return undefined
    const entries = parseJsonLines(text)
    const first = entries.find((e) => asObject(e) !== undefined)
    if (!first) return undefined
    const obj = asObject(first)!
    const sessionId = asString(obj.sessionId) ?? basename(file, '.jsonl')
    const projectDir = dirname(file)
    const cwd = entries.map((e) => asString(asObject(e)?.cwd)).find((v): v is string => !!v)
    const firstUser = entries.find((e) => isRealUserPrompt(e))
    const startedAt = entries.map(timestampOf).filter((n): n is number => n !== undefined).sort((a, b) => a - b)[0]
    let updatedAt = startedAt
    try {
      updatedAt = Math.max(updatedAt ?? 0, statSync(file).mtimeMs)
    } catch {}
    return {
      platform: 'claude-code',
      sessionId,
      file,
      projectDir,
      cwd,
      startedAt,
      updatedAt,
      preview: firstUser ? preview(contentText(firstUser), 60) : undefined,
    }
  }

  private fingerprint(entries: unknown[], hits: Hit[]): FormatFingerprint {
    const entryTypes = fingerprintTypes(entries)
    const versions = [...new Set(entries.map((e) => asString(asObject(e)?.version)).filter((v): v is string => !!v))]
    const unknownTypes = Object.keys(entryTypes).filter((t) => !CLAUDE_TYPES.has(t))
    return { platform: 'claude-code', versions, entryTypes, unknownTypes }
  }

  private transcriptOps(store: StoreRef, file: JsonlFile, hits: Hit[], explicitLines: Set<number>, scope: 'turn' | 'span'): OpsResult {
    const entries = Array.from({ length: file.length }, (_, i) => file.get(i))
    const ops: Op[] = []
    const blockers: string[] = []
    const deleted = new Set<number>()
    const add = (op: Op) => {
      if (op.op !== 'delete-file' && op.op !== 'delete-entry' && op.op !== 'delete-line' && 'line' in op && op.line !== undefined && deleted.has(op.line)) return
      ops.push(op)
    }
    const deleteTurn = (line: number) => {
      let end = line + 1
      while (end < entries.length && !isRealUserPrompt(entries[end]) && !isCompactBoundary(entries[end])) end++
      for (let i = line; i < end; i++) deleted.add(i)
    }
    const byLine = new Map<number, Hit[]>()
    for (const hit of hits) {
      if (hit.locator.line === undefined) continue
      const list = byLine.get(hit.locator.line) ?? []
      list.push(hit)
      byLine.set(hit.locator.line, list)
    }
    for (const line of explicitLines) {
      const list = byLine.get(line) ?? []
      if (!list.length) byLine.set(line, [{ store, locator: { line }, how: 'dependency', confidence: 1 }])
    }

    for (const [line, lineHits] of byLine) {
      const entry = asObject(entries[line])
      if (!entry) continue
      const type = asString(entry.type) ?? '<unknown>'
      if (!CLAUDE_TYPES.has(type)) {
        blockers.push(`未知条目类型 ${type} 含命中，格式可能变了`)
        continue
      }
      if (explicitLines.has(line)) {
        if (type === 'user' && entry.isCompactSummary !== true && !isToolResult(entry)) deleteTurn(line)
        else deleted.add(line)
        continue
      }
      if (type === 'user') {
        if (entry.isCompactSummary === true) {
          for (const hit of lineHits) if (hit.locator.pointer) add(this.redactHit(store, line, hit))
        } else if (isToolResult(entry)) {
          deleted.add(line)
        } else if (lineHits.length) {
          if (scope === 'span') for (const hit of lineHits) add(this.redactHit(store, line, hit))
          else deleteTurn(line)
        }
        continue
      }
      if (type === 'assistant') {
        if (explicitLines.has(line)) {
          deleted.add(line)
          continue
        }
        for (const hit of lineHits) {
          const pointer = hit.locator.pointer ?? ''
          const m = /^\/message\/content\/(\d+)\/(.+)$/.exec(pointer)
          if (!m) {
            add(this.redactHit(store, line, hit))
            continue
          }
          const index = Number(m[1])
          const block = blocksOf(entry)[index]
          if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
            add({ op: 'remove-element', store, line, pointer: `/message/content/${index}`, reason: '删除命中的 thinking 块' })
          } else if (block?.type === 'tool_use') {
            deleted.add(line)
          } else {
            add(this.redactHit(store, line, hit))
          }
        }
        continue
      }
      if (type === 'last-prompt') {
        for (const hit of lineHits) {
          if (hit.locator.pointer === '/lastPrompt') add(this.redactHit(store, line, hit))
          else add(this.redactHit(store, line, hit))
        }
        continue
      }
      if (type === 'ai-title') {
        add({ op: 'set-field', store, line, pointer: '/aiTitle', value: '（已编辑的会话）', reason: '标题含目标' })
        continue
      }
      if (type === 'api-request' || type === 'api-request-blob' || type === 'api-request-shape' || type === 'attachment') {
        deleted.add(line)
        continue
      }
      for (const hit of lineHits) add(this.redactHit(store, line, hit))
    }

    // tool_use <-> tool_result closure.
    const useLines = new Map<string, number>()
    const resultLines = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) {
      for (const block of blocksOf(entries[i])) {
        const id = asString(block.id) ?? asString(block.tool_use_id)
        if (!id) continue
        if (block.type === 'tool_use') useLines.set(id, i)
        if (block.type === 'tool_result') resultLines.set(id, i)
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const line of [...deleted]) {
        for (const block of blocksOf(entries[line])) {
          const id = asString(block.id) ?? asString(block.tool_use_id)
          if (!id) continue
          const other = block.type === 'tool_use' ? resultLines.get(id) : block.type === 'tool_result' ? useLines.get(id) : undefined
          if (other !== undefined && !deleted.has(other)) {
            deleted.add(other)
            changed = true
          }
        }
      }
    }

    // Parent / logical parent relink.
    const parentOf = new Map<string, string | null>()
    const lineOfUuid = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) {
      const e = asObject(entries[i])
      const uuid = asString(e?.uuid)
      if (!uuid) continue
      lineOfUuid.set(uuid, i)
      const p = e?.parentUuid
      parentOf.set(uuid, typeof p === 'string' ? p : null)
    }
    const survivor = (uuid: string | null): string | null => {
      let cur = uuid
      const seen = new Set<string>()
      while (cur) {
        if (seen.has(cur)) return null
        seen.add(cur)
        const line = lineOfUuid.get(cur)
        if (line === undefined || !deleted.has(line)) return cur
        cur = parentOf.get(cur) ?? null
      }
      return null
    }
    const dangling = new Set<number>()
    for (let i = 0; i < entries.length; i++) {
      if (deleted.has(i)) continue
      const e = asObject(entries[i])
      if (!e) continue
      for (const field of ['parentUuid', 'logicalParentUuid'] as const) {
        const old = asString(e[field])
        if (!old) continue
        const next = survivor(old)
        if (next !== old) {
          add({ op: 'set-field', store, line: i, pointer: `/${field}`, value: next, reason: '删除后重接父链' })
        }
        if (next && !lineOfUuid.has(next)) dangling.add(i)
      }
      if (e.type === 'last-prompt') {
        const leaf = asString(e.leafUuid)
        if (leaf) {
          const next = survivor(leaf)
          if (next !== leaf) {
            if (next) add({ op: 'set-field', store, line: i, pointer: '/leafUuid', value: next, reason: '重接叶子' })
            else add({ op: 'delete-entry', store, line: i, reason: '叶子已删且无保留祖先' })
          }
        }
      }
      if (e.type === 'system' && asString(e.subtype) === 'compact_boundary') {
        const uuids = asArray(asObject(getAt(e, '/compactMetadata/preservedMessages'))?.uuids)
        const kept = uuids.filter((u): u is string => typeof u === 'string' && !deleted.has(lineOfUuid.get(u) ?? -1))
        if (kept.length !== uuids.length) {
          add({ op: 'set-field', store, line: i, pointer: '/compactMetadata/preservedMessages/uuids', value: kept, reason: '从 preservedMessages 移除已删项' })
        }
      }
    }
    if (dangling.size) blockers.push('删除后存在悬空 parentUuid，拒绝执行')

    for (const line of [...deleted].sort((a, b) => b - a)) {
      add({ op: 'delete-entry', store, line, reason: '删除命中的回合/条目' })
    }
    // Remove edits that target deleted lines.
    const filtered = ops.filter((op) => !('line' in op) || op.line === undefined || !deleted.has(op.line) || op.op === 'delete-entry')
    return { ops: filtered, blockers }
  }

  private redactHit(store: StoreRef, line: number, hit: Hit): Op {
    const pointer = hit.locator.pointer ?? ''
    return {
      op: 'redact-span',
      store,
      line,
      pointer,
      start: hit.locator.start ?? 0,
      end: hit.locator.end ?? 0,
      replacement: '（已删除）',
      reason: '删除命中文本',
    }
  }

  private historyOps(store: StoreRef, hits: Hit[], session: SessionRef): Op[] {
    const text = safeReadText(store.path) ?? ''
    const lines = jsonLines(text)
    const out: Op[] = []
    for (const line of [...new Set(hits.map((h) => h.locator.line ?? -1).filter((i) => i >= 0))]) {
      let parsed: unknown
      try { parsed = JSON.parse(lines[line] ?? '') } catch { parsed = undefined }
      const obj = asObject(parsed)
      const sessionId = asString(obj?.sessionId)
      const project = asString(obj?.project) ?? asString(obj?.cwd)
      if (sessionId !== undefined && sessionId !== session.sessionId) continue
      if (sessionId === undefined && project !== undefined && session.cwd && resolve(project) !== resolve(session.cwd)) continue
      out.push({ op: 'delete-line', store, line, reason: '命中用户输入历史' })
    }
    return out
  }

  private memoryOps(store: StoreRef, hits: Hit[], targetTexts: string[]): Op[] {
    const text = safeReadText(store.path) ?? ''
    const spans = findSpans(text, targetTexts)
    const covered = spans.reduce((n, s) => n + (s.end - s.start), 0)
    const heading = text.split(/\r?\n/).find((line) => /^#{1,3}\s/.test(line)) ?? ''
    const dedicated = store.kind === 'cc-memory' && (findSpans(basename(store.path), targetTexts).length > 0 || findSpans(heading, targetTexts).length > 0 || (text.length > 0 && covered * 2 >= text.length))
    if (dedicated) return [{ op: 'delete-file', store, reason: '专门记录目标的 memory 文件' }]
    return hits
      .filter((h) => h.locator.start !== undefined && h.locator.end !== undefined)
      .map((h) => ({
        op: 'redact-span' as const,
        store,
        start: h.locator.start!,
        end: h.locator.end!,
        replacement: '（已删除）',
        reason: 'memory 命中文本',
      }))
  }

  private textOps(store: StoreRef, hits: Hit[]): Op[] {
    return hits
      .filter((h) => h.locator.start !== undefined && h.locator.end !== undefined)
      .map((h) => ({
        op: 'redact-span' as const,
        store,
        start: h.locator.start!,
        end: h.locator.end!,
        replacement: '（已删除）',
        reason: '会话外副本命中',
      }))
  }

  private residual(ops: Op[], stores: StoreRef[], targetTexts: string[], session: SessionRef): number {
    if (!targetTexts.length) return 0
    const byPath = new Map<string, Op[]>()
    for (const op of ops) byPath.set(op.store.path, [...(byPath.get(op.store.path) ?? []), op])
    let count = 0
    for (const store of stores) {
      const list = byPath.get(store.path)
      let text: string | null
      if (!list?.length) {
        text = safeReadText(store.path) ?? null
      } else if (list.some((o) => o.op === 'delete-file')) {
        text = null
      } else {
        const raw = safeReadText(store.path)
        if (raw === undefined) text = null
        else if (store.path.endsWith('.jsonl')) {
          const file = new JsonlFile(raw)
          applyToJsonl(file, list)
          text = file.toString()
        } else {
          text = applyToText(raw, list)
        }
      }
      if (!text) continue
      const scan = store.kind === 'cc-history' ? text.split(/\r?\n/).filter((line) => {
        try {
          const o = asObject(JSON.parse(line))
          return asString(o?.sessionId) === session.sessionId || (o?.sessionId === undefined && (!o?.project || !session.cwd || resolve(asString(o.project) ?? '') === resolve(session.cwd)))
        } catch { return false }
      }).join('\n') : text
      for (const needle of targetTexts) count += findSpans(scan, [needle]).length
    }
    return count
  }
}


function isCompactBoundary(entry: unknown): boolean {
  const obj = asObject(entry)
  return obj?.type === 'system' && obj.subtype === 'compact_boundary'
}
