import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/claude.js'
import { encodeDshLog, readDshLog } from '../src/fsx.js'
import { DshAdapter } from '../src/dsh.js'
import { applyPlan } from '../src/apply.js'
import { buildPlan } from '../src/plan.js'
import { Store } from '../src/store.js'
import type { SessionRef, Target } from '../src/types.js'

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'unremember-adapter-'))
  dirs.push(dir)
  return dir
}
beforeEach(() => {
  process.env.UNREMEMBER_DSH_LOCK_PROBE = 'off'
  process.env.UNREMEMBER_CLAUDE_LIVE_PROBE = 'off'
})
afterEach(() => {
  delete process.env.UNREMEMBER_DSH_LOCK_PROBE
  delete process.env.UNREMEMBER_CLAUDE_LIVE_PROBE
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ClaudeAdapter', () => {
  it('keeps a compact boundary and rewrites the summary instead of deleting it', async () => {
    const root = temp()
    const project = join(root, 'projects', 'C--fixture-work')
    mkdirSync(project, { recursive: true })
    const sid = '22222222-2222-4222-8222-222222222222'
    const file = join(project, `${sid}.jsonl`)
    const entries = [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'secret 青柠绿-7429' }, sessionId: sid, version: '2.1.309' },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, sessionId: sid, version: '2.1.309' },
      { type: 'system', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a1', subtype: 'compact_boundary', compactMetadata: { preservedMessages: { uuids: ['a1'] } }, sessionId: sid, version: '2.1.309' },
      { type: 'user', uuid: 's1', parentUuid: 'b1', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'summary 青柠绿-7429' }, sessionId: sid, version: '2.1.309' },
      { type: 'user', uuid: 'u2', parentUuid: 's1', message: { role: 'user', content: 'next' }, sessionId: sid, version: '2.1.309' },
    ]
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const adapter = new ClaudeAdapter(root)
    const session = adapter.listSessions()[0]!
    const { draft } = await adapter.plan(session, { text: ['青柠绿-7429'] })
    expect(draft.ops.some((op) => op.op === 'delete-entry' && op.line === 2)).toBe(false)
    expect(draft.ops.some((op) => op.op === 'redact-span' && op.line === 3)).toBe(true)
    expect(draft.residualHits).toBe(0)
  })

  it('plans turn deletion, memory index cleanup, history and relinking', async () => {
    const root = temp()
    const project = join(root, 'projects', 'C--fixture-work')
    const data = join(root, 'data')
    mkdirSync(join(project, 'memory'), { recursive: true })
    mkdirSync(data, { recursive: true })
    const sid = '11111111-1111-4111-8111-111111111111'
    const file = join(project, `${sid}.jsonl`)
    const entries = [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'secret 青柠绿-7429' }] }, sessionId: sid },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'remember 青柠绿-7429' }, { type: 'text', text: 'ok' }] }, sessionId: sid },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'text', text: 'weather?' }] }, sessionId: sid },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'fine' }] }, sessionId: sid },
      { type: 'last-prompt', lastPrompt: 'weather?', leafUuid: 'a2', sessionId: sid },
      { type: 'ai-title', aiTitle: '青柠绿-7429 chat', sessionId: sid },
    ]
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    writeFileSync(join(root, 'history.jsonl'), JSON.stringify({ display: 'secret 青柠绿-7429', sessionId: sid }) + '\n')
    writeFileSync(join(project, 'memory', 'MEMORY.md'), '# Memory\n- [secret](secret.md)\n')
    writeFileSync(join(project, 'memory', 'secret.md'), 'The secret is 青柠绿-7429.\n')

    const adapter = new ClaudeAdapter(root)
    const sessions = adapter.listSessions()
    expect(sessions).toHaveLength(1)
    const session = sessions[0]!
    const target: Target = { text: ['青柠绿-7429'] }
    const { draft, hits } = await adapter.plan(session, target)
    expect(hits.length).toBe(5)
    expect(draft.residualHits).toBe(0)
    expect(draft.ops.some((op) => op.op === 'redact-span' && op.store.path.endsWith('secret.md'))).toBe(true)
    expect(draft.ops.some((op) => op.op === 'delete-file' && op.store.path.endsWith('secret.md'))).toBe(false)
    expect(draft.ops.some((op) => op.op === 'set-field' && op.pointer === '/parentUuid')).toBe(true)

    const store = new Store(data)
    const plan = buildPlan(store, draft, target)
    store.savePlan(plan)
    applyPlan(plan, store)
    expect(readFileSync(file, 'utf8')).not.toContain('青柠绿-7429')
    expect(readFileSync(join(root, 'history.jsonl'), 'utf8')).not.toContain('青柠绿-7429')
    expect(readFileSync(join(project, 'memory', 'secret.md'), 'utf8')).not.toContain('青柠绿-7429')
    expect(readFileSync(join(project, 'memory', 'MEMORY.md'), 'utf8')).toContain('secret.md')
    expect(() => readFileSync(session.file, 'utf8')).not.toThrow()

    store.restore(plan.id)
    expect(readFileSync(file, 'utf8')).toContain('青柠绿-7429')
  })
})

describe('DshAdapter', () => {
  it('round-trips a compressed v4 log in the header/batch frame layout', async () => {
    const root = temp()
    const dir = join(root, 'sessions', '--C-fixture-work--', 'session-zstd')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    const text = [
      { type: 'session', version: 4, id: 'session-zstd', createdAt: 1, cwd: 'C:\\fixture-work' },
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '青柠绿-7429' }], role: 'user' } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(file, encodeDshLog(text, true))
    const adapter = new DshAdapter(root)
    const session = adapter.listSessions()[0]!
    const target = { text: ['青柠绿-7429'] }
    const { draft } = await adapter.plan(session, target)
    const store = new Store(join(root, 'data'))
    const plan = buildPlan(store, draft, target)
    applyPlan(plan, store)
    expect(readDshLog(file)).not.toContain('青柠绿-7429')
    expect(readDshLog(file).split('\n')[0]).toContain('"type":"session"')
  })


  it('honors --scope span for dsh instead of blanking the whole text field', async () => {
    const root = temp()
    const dir = join(root, 'sessions', '--C-fixture-work--', 'session-span')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl')
    const entries = [
      { type: 'session', version: 4, id: 'session-span', createdAt: 1, cwd: 'C:\\fixture-work' },
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'prefix 青柠绿-7429 suffix' }], role: 'user' } },
    ]
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const adapter = new DshAdapter(root)
    const session = adapter.listSessions()[0]!
    const target = { text: ['青柠绿-7429'] }
    const { draft } = await adapter.plan(session, target, { scope: 'span' })
    expect(draft.ops.some((op) => op.op === 'redact-span' && op.pointer === '/data/content/0/text')).toBe(true)
    expect(draft.ops.some((op) => op.op === 'blank-field' && op.pointer === '/data/content/0/text')).toBe(false)
  })

  it('blanks message fields without changing seq and keeps the log resumable in shape', async () => {
    const root = temp()
    const dir = join(root, 'sessions', '--C-fixture-work--', 'session-test')
    mkdirSync(dir, { recursive: true })
    const sid = 'session-test'
    const file = join(dir, 'session.v4.jsonl')
    const entries = [
      { type: 'session', version: 4, id: sid, createdAt: 1, cwd: 'C:\\fixture-work', isSeeded: false, delegationDepth: 0 },
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'secret 青柠绿-7429' }], source: { kind: 'user' }, role: 'user', id: 'u1' }, surfaceOp: 'append' },
      { type: 'agent/inbox/spliced', seq: 1, time: 2, data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: 'secret 青柠绿-7429' }], role: 'user' }] } },
      { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '青柠绿-7429' }], source: { replayState: { x: 1 } } }, usage: {}, stream: [{ type: 'text', text: '青柠绿-7429' }, { type: 'tool-call', chunk: { block: { arguments: '青柠绿-7429' } } }] }, surfaceOp: 'append' },
      { type: 'session/title', seq: 3, time: 4, data: { title: '青柠绿-7429', messageSeqs: [0] } },
    ]
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const adapter = new DshAdapter(root)
    const session = adapter.listSessions()[0] as SessionRef
    expect(session.sessionId).toBe(sid)
    const target: Target = { text: ['青柠绿-7429'] }
    const { draft } = await adapter.plan(session, target)
    expect(draft.residualHits).toBe(0)
    expect(draft.ops.some((op) => op.op === 'set-field' && op.pointer === '/data/stream')).toBe(true)
    expect(draft.ops.some((op) => op.op === 'set-field' && op.pointer === '/data/message/source/replayState')).toBe(true)

    const store = new Store(join(root, 'data'))
    const plan = buildPlan(store, draft, target)
    applyPlan(plan, store)
    const after = readFileSync(file, 'utf8')
    expect(after).not.toContain('青柠绿-7429')
    const seqs = after.trim().split(/\r?\n/).slice(1).map((line) => JSON.parse(line).seq)
    expect(seqs).toEqual([0, 1, 2, 3])
  })
})
