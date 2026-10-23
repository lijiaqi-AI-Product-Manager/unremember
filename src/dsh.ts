import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { JsonlFile, encodeDshLog, readDshLog, sha256File } from './fsx.js'
import { applyToJsonl, applyToText } from './ops.js'
import { applyPlanWithLive } from './apply-core.js'
import { Store } from './store.js'
import { dshHome } from './paths.js'
import { excerpt, findSpans, stringLeaves } from './text.js'
import { semanticConfig, semanticLocate, toHits } from './semantic.js'
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
import { asArray, asObject, asString, blocksOf, fingerprintTypes, isTextFile, listFiles, preview, safeReadText, timestampOf } from './util.js'

const KNOWN_DSH_TYPES = new Set([
  'session',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
  'turn/start',
  'step/start',
  'system/message',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'request/header',
  'request/context',
  'session/title',
  'session/title-llm-request',
  'session-log-deepseek/delivery-accepted',
  'step/end',
  'turn/end',
  'session/end-seed',
  'command/run',
  'command/done',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'compaction/prune',
  'cost-state',
])

interface DshFile {
  file: string
  text: string
  lines: JsonlFile
  header: Record<string, unknown>
  generation: number
}

export class DshAdapter implements Adapter {
  readonly platform = 'dsh' as const
  readonly root: string

  constructor(root = dshHome()) {
    this.root = resolve(root)
  }

  private sessionsDir() {
    return join(this.root, 'sessions')
  }

  private sessionDir(session: SessionRef) {
    return dirname(session.file)
  }

  listSessions(options: { cwd?: string } = {}): SessionInfo[] {
    const out: SessionInfo[] = []
    for (const file of this.files()) {
      const info = this.info(file)
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
    try {
      if (statSync(absolute).isFile()) {
        const info = this.info(absolute)
        if (info) return info
      }
    } catch {}
    const exact = sessions.find((s) => s.sessionId === query)
    if (exact) return exact
    const prefixed = sessions.filter((s) => s.sessionId.startsWith(query))
    if (prefixed.length === 1) return prefixed[0]
    if (prefixed.length > 1) throw new Error(`会话 id 前缀 "${query}" 不唯一`)
    return undefined
  }

  liveState(session: SessionRef): LiveState {
    if (process.env.UNREMEMBER_DSH_LOCK_PROBE === 'off') return 'idle'
    const lock = join(this.sessionDir(session), 'session.lock')
    if (process.platform === 'win32') return this.win32LockState(lock)
    try {
      statSync(lock)
    } catch {
      return 'idle'
    }
    for (const command of ['lsof', 'fuser']) {
      try {
        const r =
          command === 'lsof'
            ? spawnSync('lsof', ['-t', lock], { encoding: 'utf8', timeout: 5000 })
            : spawnSync('fuser', [lock], { encoding: 'utf8', timeout: 5000 })
        if (r.error) return 'unknown'
        if (r.status === 0 && (r.stdout || r.stderr).trim()) return 'live'
        if (r.status === 1) return 'idle'
      } catch {
        return 'unknown'
      }
    }
    return 'unknown'
  }

  stores(session: SessionRef): StoreRef[] {
    const out: StoreRef[] = [{ kind: 'dsh-session', path: session.file }]
    for (const file of this.filesInDir(this.sessionDir(session))) {
      if (file !== session.file) out.push({ kind: 'dsh-session-old-gen', path: file })
    }
    const cache = join(this.root, 'storages', 'session_projcache', 'sessions', `${session.sessionId}.json`)
    if (safeReadText(cache) !== undefined) out.push({ kind: 'dsh-storage', path: cache })
    const storageRoot = join(this.root, 'storages')
    for (const file of listFiles(storageRoot, (f) => f.endsWith('.json') && isTextFile(f))) {
      if (file === cache) continue
      const text = safeReadText(file) ?? ''
      if (text.includes(session.sessionId)) out.push({ kind: 'dsh-storage', path: file })
    }
    for (const file of listFiles(join(this.root, 'attachments'), (f) => isTextFile(f))) {
      out.push({ kind: 'dsh-attachment', path: file })
    }
    return out
  }

  async plan(session: SessionRef, target: Target, options: PlanOptions = {}): Promise<{ draft: PlanDraft; hits: Hit[] }> {
    if (target.about && !target.text?.length && !target.messageIds?.length && !options.semantic) {
      throw new Error('--about 需要同时传 --semantic')
    }
    const targetTexts = [...(target.text ?? [])].filter((s) => s.length > 0)
    const seqs = new Set((target.messageIds ?? []).map((s) => Number(s)).filter((n) => Number.isInteger(n)))
    if (!targetTexts.length && !seqs.size && !(options.semantic && target.about)) throw new Error('没有目标文本、seq 或 --about --semantic')
    const stores = this.stores(session)
    const hits: Hit[] = []
    for (const store of stores) {
      const isJsonl = store.path.endsWith('.jsonl') || store.path.endsWith('.jsonl.zstd')
      if (isJsonl) {
        const raw = readDshLog(store.path)
        const file = new JsonlFile(raw)
        for (let line = 0; line < file.length; line++) {
          const event = file.get(line)
          if (!event) continue
          const seq = asObject(event)?.seq
          if (typeof seq === 'number' && seqs.has(seq)) {
            hits.push({ store, locator: { line }, how: 'dependency', confidence: 1, excerpt: `[seq ${seq}]`, reason: 'explicit seq' })
          }
          if (!targetTexts.length) continue
          for (const leaf of stringLeaves(event)) {
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
      } else {
        const text = safeReadText(store.path)
        if (text === undefined) continue
        for (const span of findSpans(text, targetTexts)) {
          hits.push({ store, locator: { start: span.start, end: span.end }, how: 'exact', confidence: 1, excerpt: excerpt(text, span) })
        }
      }
    }

    if (options.semantic) {
      if (!semanticConfig()) throw new Error('--semantic 需要 UNREMEMBER_SEMANTIC_BASE_URL / UNREMEMBER_SEMANTIC_MODEL')
      const description = target.about ?? targetTexts.join(' / ')
      if (!description.trim()) throw new Error('--semantic 需要一个目标描述')
      const semantic = await semanticLocate(session, stores, description, targetTexts)
      const merged = mergeHits(hits, toHits(semantic))
      hits.length = 0
      hits.push(...merged)
    }

    const first = this.readFile(session.file)
    if (seqs.size && !hits.some((h) => h.reason === 'explicit seq')) throw new Error('在会话里找不到指定的 seq')
    const fingerprint = this.fingerprint(first, hits)
    const blockers: string[] = []
    if (first.header.version !== 4) blockers.push(`dsh session header version=${String(first.header.version)}，只支持 v4`)
    if (fingerprint.unknownTypes.some((type) => hits.some((h) => asString(asObject(first.lines.get(h.locator.line ?? -1))?.type) === type))) {
      blockers.push('命中落在未知 dsh 事件类型上，拒绝执行')
    }
    const ops: Op[] = []
    const byPath = new Map<string, Hit[]>()
    for (const hit of hits) byPath.set(hit.store.path, [...(byPath.get(hit.store.path) ?? []), hit])
    for (const store of stores) {
      const storeHits = byPath.get(store.path)
      if (!storeHits?.length) continue
      if (store.kind === 'dsh-session' || store.kind === 'dsh-session-old-gen') {
        ops.push(...this.sessionOps(store, storeHits, seqs))
      } else {
        ops.push(...this.textOps(store, storeHits))
      }
    }
    const touched = [...new Set(ops.filter((o) => o.op !== 'delete-file').map((o) => o.store.path))]
    const deleted = [...new Set(ops.filter((o) => o.op === 'delete-file').map((o) => o.store.path))]
    const files = [...touched, ...deleted]
      .map((path) => ({ path, sha256Before: sha256File(path) }))
      .filter((f, i, a) => a.findIndex((x) => x.path === f.path) === i)
    const residualHits = this.residual(ops, stores, targetTexts)
    if (residualHits > 0) blockers.push(`模拟执行后仍残留 ${residualHits} 处精确命中`)
    return {
      draft: { session, fingerprint, ops, files, warnings: [], blockers: [...new Set(blockers)], residualHits },
      hits,
    }
  }

  apply(plan: Plan): void {
    applyPlanWithLive(plan, new Store(), (session) => this.liveState(session))
  }

  /** Copy one session into a new id under the same root. The parent stays byte-identical. */
  forkForVerify(session: SessionRef): { session: SessionRef; cleanup: () => void } {
    const source = this.readFile(session.file)
    const newId = `session-${randomUUID()}`
    const dir = join(this.sessionDir(session), '..', newId)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, basename(session.file))
    const rewritten = source.text.replaceAll(session.sessionId, newId)
    const out = encodeDshLog(rewritten, session.file.endsWith('.zstd'))
    writeFileSync(target, out)
    return {
      session: { platform: 'dsh', sessionId: newId, file: target, projectDir: dirname(target) },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
  }

  private files(): string[] {
    const out: string[] = []
    let projects: string[] = []
    try {
      projects = readdirSync(this.sessionsDir()) as string[]
    } catch {
      return out
    }
    for (const project of projects) {
      const projectDir = join(this.sessionsDir(), project)
      let sessions: string[] = []
      try {
        sessions = readdirSync(projectDir) as string[]
      } catch {
        continue
      }
      for (const id of sessions) {
        const dir = join(projectDir, id)
        const files = this.filesInDir(dir)
        const current = files.sort((a, b) => generation(b) - generation(a))[0]
        if (current) out.push(current)
      }
    }
    return out
  }

  private filesInDir(dir: string): string[] {
    let names: string[] = []
    try {
      names = readdirSync(dir) as string[]
    } catch {
      return []
    }
    return names
      .filter((name) => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name))
      .map((name) => join(dir, name))
  }

  private readFile(file: string): DshFile {
    const text = readDshLog(file)
    const lines = new JsonlFile(text)
    const header = asObject(lines.get(0))
    if (!header || header.type !== 'session') throw new Error(`${file} 不是 dsh session 文件`)
    return { file, text, lines, header, generation: generation(file) }
  }

  private info(file: string): SessionInfo | undefined {
    try {
      const d = this.readFile(file)
      const id = asString(d.header.id)
      if (!id) return undefined
      const firstUser = Array.from({ length: d.lines.length }, (_, i) => d.lines.get(i)).find((e) => asObject(e)?.type === 'user/message')
      const text = firstUser ? eventText(firstUser) : ''
      let updatedAt = 0
      try {
        updatedAt = statSync(file).mtimeMs
      } catch {}
      const cwd = asString(d.header.cwd) ? resolve(asString(d.header.cwd)!) : undefined
      return {
        platform: 'dsh',
        sessionId: id,
        file,
        projectDir: cwd ?? dirname(file),
        cwd,
        startedAt: typeof d.header.createdAt === 'number' ? d.header.createdAt : timestampOf(firstUser),
        updatedAt,
        preview: text ? preview(text, 60) : undefined,
      }
    } catch {
      return undefined
    }
  }

  private fingerprint(file: DshFile, hits: Hit[]): FormatFingerprint {
    const entries = Array.from({ length: file.lines.length }, (_, i) => file.lines.get(i))
    const entryTypes = fingerprintTypes(entries)
    const unknownTypes = Object.keys(entryTypes).filter((t) => !KNOWN_DSH_TYPES.has(t))
    return { platform: 'dsh', versions: [String(file.header.version)], entryTypes, unknownTypes }
  }

  private sessionOps(store: StoreRef, hits: Hit[], seqs: Set<number>): Op[] {
    const raw = readDshLog(store.path)
    const file = new JsonlFile(raw)
    const out: Op[] = []
    const byLine = new Map<number, Hit[]>()
    for (const hit of hits) {
      if (hit.locator.line === undefined) continue
      byLine.set(hit.locator.line, [...(byLine.get(hit.locator.line) ?? []), hit])
    }
    for (const [line, lineHits] of byLine) {
      const event = asObject(file.get(line))
      if (!event) continue
      const type = asString(event.type) ?? ''
      for (const hit of lineHits) {
        const pointer = hit.locator.pointer ?? ''
        if (!pointer) continue
        if (type === 'agent/inbox/spliced' || type === 'user/message') {
          if (/\/text$/.test(pointer)) out.push(blank(store, line, pointer, 'dsh 消息正文'))
          else out.push(redact(store, line, hit))
        } else if (type === 'assistant/message') {
          if (pointer.startsWith('/data/stream') || pointer.startsWith('/data/message/source/replayState')) {
            // The whole stream/replay state is cleared below; redacting a nested
            // field after that would point at a value that no longer exists.
            continue
          }
          if (/\/(text|thinking)$/.test(pointer)) out.push(blank(store, line, pointer, 'dsh assistant 正文'))
          else out.push(redact(store, line, hit))
        } else if (type === 'compaction/summary') {
          out.push(redact(store, line, hit))
        } else if (type.startsWith('session/title')) {
          out.push(redact(store, line, hit))
        } else if (type === 'request/header' || type === 'request/context') {
          out.push(redact(store, line, hit))
        } else if (type === 'session-log-deepseek/delivery-accepted') {
          out.push(redact(store, line, hit))
        } else if (!KNOWN_DSH_TYPES.has(type)) {
          // Blocked by the caller's fingerprint check.
        } else {
          out.push(redact(store, line, hit))
        }
      }
      if (seqs.has(Number(event.seq)) && !lineHits.some((h) => h.locator.pointer)) {
        // Explicit seq without a text pointer: blank only textual message leaves, never type/seq.
        for (const leaf of stringLeaves(event)) {
          if (/(?:^|\/)(?:text|thinking)$/.test(leaf.pointer) || /^\/data\/(?:content|message\/content)$/.test(leaf.pointer)) {
            out.push(blank(store, line, leaf.pointer, '显式 seq'))
          }
        }
      }
      if (type === 'assistant/message' && lineHits.length) {
        if (asObject(event.data)?.stream !== undefined) out.push({ op: 'set-field', store, line, pointer: '/data/stream', value: [], reason: '清空 assistant 流' })
        const source = asObject(asObject(event.data)?.message)?.source
        if (asObject(source)?.replayState !== undefined) {
          out.push({ op: 'set-field', store, line, pointer: '/data/message/source/replayState', value: {}, reason: '清空 replayState' })
        }
      }
    }
    // De-duplicate explicit blanks and redactions by pointer.
    const seen = new Set<string>()
    return out.filter((op) => {
      const key = `${op.store.path}:${'line' in op ? op.line : ''}:${op.op}:${'pointer' in op ? op.pointer : ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
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
        reason: 'dsh 会话外副本命中',
      }))
  }

  private residual(ops: Op[], stores: StoreRef[], targetTexts: string[]): number {
    if (!targetTexts.length) return 0
    const byPath = new Map<string, Op[]>()
    for (const op of ops) byPath.set(op.store.path, [...(byPath.get(op.store.path) ?? []), op])
    let n = 0
    for (const store of stores) {
      const list = byPath.get(store.path)
      let text: string | undefined
      if (!list?.length) text = store.path.endsWith('.zstd') ? readDshLog(store.path) : safeReadText(store.path)
      else if (list.some((o) => o.op === 'delete-file')) text = undefined
      else if (store.path.endsWith('.jsonl') || store.path.endsWith('.jsonl.zstd')) {
        const f = new JsonlFile(readDshLog(store.path))
        applyToJsonl(f, list)
        text = f.toString()
      } else {
        const raw = safeReadText(store.path)
        text = raw === undefined ? undefined : applyToText(raw, list) ?? undefined
      }
      if (!text) continue
      for (const needle of targetTexts) n += findSpans(text, [needle]).length
    }
    return n
  }

  private win32LockState(lock: string): LiveState {
    const name = `Local\\dsh-session-lock-${createHash('sha256').update(resolve(lock).toLowerCase()).digest('hex')}`
    const script = [
      '$ErrorActionPreference="Stop"',
      'Add-Type -TypeDefinition @"',
      'using System; using System.Runtime.InteropServices;',
      'public static class DshLock {',
      ' [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr OpenSemaphore(uint a, bool b, string n);',
      ' [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);',
      ' [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
      '}',
      '"@',
      `$h=[DshLock]::OpenSemaphore(0x00100001,$false,'${name.replace(/'/g, "''")}')`,
      'if($h -eq [IntPtr]::Zero){exit 2}',
      '$r=[DshLock]::WaitForSingleObject($h,0)',
      '[void][DshLock]::CloseHandle($h)',
      'if($r -eq 0){exit 3}',
      'if($r -eq 258){exit 0}',
      'exit 4',
    ].join('\n')
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 10000 })
      if (r.error) return 'unknown'
      if (r.status === 0) return 'live'
      if (r.status === 2 || r.status === 3) return 'idle'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

function generation(file: string): number {
  const m = /^session(?:\.v(\d+))?\.jsonl/.exec(basename(file))
  return m?.[1] ? Number(m[1]) : 0
}

function eventText(event: unknown): string {
  const obj = asObject(event)
  const data = asObject(obj?.data)
  if (data) {
    const content = data.content
    if (Array.isArray(content)) {
      return content.map((b) => asString(asObject(b)?.text) ?? '').join('\n')
    }
    const message = asObject(data.message)
    if (Array.isArray(message?.content)) {
      return message.content.map((b) => asString(asObject(b)?.text) ?? '').join('\n')
    }
  }
  return ''
}

function blank(store: StoreRef, line: number, pointer: string, reason: string): Op {
  return { op: 'blank-field', store, line, pointer, value: '', reason }
}

function redact(store: StoreRef, line: number, hit: Hit): Op {
  return {
    op: 'redact-span',
    store,
    line,
    pointer: hit.locator.pointer ?? '',
    start: hit.locator.start ?? 0,
    end: hit.locator.end ?? 0,
    replacement: '（已删除）',
    reason: 'dsh 命中文本',
  }
}

function mergeHits(base: Hit[], extra: Hit[]): Hit[] {
  const seen = new Set(base.map((h) => `${h.store.path}:${h.locator.line ?? ''}:${h.locator.pointer ?? ''}:${h.locator.start ?? ''}:${h.locator.end ?? ''}`))
  const out = [...base]
  for (const hit of extra) {
    const key = `${hit.store.path}:${hit.locator.line ?? ''}:${hit.locator.pointer ?? ''}:${hit.locator.start ?? ''}:${hit.locator.end ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}
