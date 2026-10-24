import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/claude.js'
import { applyPlan } from '../src/apply.js'
import { buildPlan } from '../src/plan.js'
import { Store } from '../src/store.js'
import { sha256File } from '../src/fsx.js'
import type { Plan } from '../src/types.js'

const CANARY = '青柠绿-7429'
const cleanups: Array<() => void> = []
afterEach(() => {
  delete process.env.UNREMEMBER_CLAUDE_LIVE_PROBE
  while (cleanups.length) cleanups.pop()!()
  delete process.env.UNREMEMBER_DSH_LOCK_PROBE
})

beforeEach(() => {
  process.env.UNREMEMBER_CLAUDE_LIVE_PROBE = 'off'
})

function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'unremember-reg-'))
  cleanups.push(() => rmSync(r, { recursive: true, force: true }))
  return r
}

function fixture(options: { bom?: boolean; torn?: boolean; memory?: boolean } = {}) {
  const base = root()
  const claude = join(base, '.claude')
  const project = join(claude, 'projects', 'C--fixture')
  mkdirSync(join(project, 'memory'), { recursive: true })
  const sid = '55555555-5555-4555-8555-555555555555'
  const entries = [
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: `remember ${CANARY}` }, sessionId: sid, cwd: join(base, 'work') },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: `noted ${CANARY}` }] }, sessionId: sid, cwd: join(base, 'work') },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'next' }, sessionId: sid, cwd: join(base, 'work') },
  ]
  let text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  if (options.bom) text = '\uFEFF' + text
  if (options.torn) text += '{"type":"user","message":"torn ' + CANARY
  const file = join(project, `${sid}.jsonl`)
  writeFileSync(file, text)
  if (options.memory) {
    writeFileSync(join(project, 'memory', 'secret.md'), `# Notes\nother context\n${CANARY}\n`)
    writeFileSync(join(project, 'memory', `codeword-${CANARY}.md`), `# ${CANARY}\n`)
    writeFileSync(join(project, 'memory', 'MEMORY.md'), '- [other](not-secret.md)\n- [secret](secret.md)\n- [code](codeword-' + CANARY + '.md)\n')
  }
  const adapter = new ClaudeAdapter(claude)
  const session = adapter.listSessions()[0]!
  return { base, claude, project, sid, file, adapter, session }
}

describe('security regressions', () => {
  it('never persists session.preview or target plaintext in a plan', async () => {
    const f = fixture()
    const { draft } = await f.adapter.plan(f.session, { text: [CANARY] })
    const plan = buildPlan(new Store(join(f.base, '.unremember')), draft, { text: [CANARY] })
    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain(CANARY)
    expect(plan.session).not.toHaveProperty('preview')
  })

  it('rejects a plan whose path is outside the adapter store set', async () => {
    const f = fixture()
    const victim = join(f.base, 'victim.txt')
    writeFileSync(victim, 'keep me\n')
    const { draft } = await f.adapter.plan(f.session, { text: [CANARY] })
    const plan: Plan = {
      ...buildPlan(new Store(join(f.base, '.unremember')), { ...draft, ops: [], files: [] }, { text: [CANARY] }),
      ops: [{ op: 'delete-line', store: { kind: 'cc-memory', path: victim }, line: 0, reason: 'malicious' }],
      files: [{ path: victim, sha256Before: sha256File(victim) }],
    }
    expect(() => applyPlan(plan, new Store(join(f.base, '.unremember')))).toThrow(/store 集合/)
    expect(readFileSync(victim, 'utf8')).toBe('keep me\n')
  })

  it('parses a leading BOM instead of silently missing the first user turn', async () => {
    const f = fixture({ bom: true })
    const { draft } = await f.adapter.plan(f.session, { text: [CANARY] })
    expect(draft.blockers).toEqual([])
    expect(draft.residualHits).toBe(0)
  })

  it('blocks a torn JSONL line instead of reporting a clean plan', async () => {
    const f = fixture({ torn: true })
    const { draft } = await f.adapter.plan(f.session, { text: [CANARY] })
    expect(draft.blockers.some((b) => b.includes('无法解析'))).toBe(true)
  })

  it('removes only the exact MEMORY.md link for a deleted memory file', async () => {
    const f = fixture({ memory: true })
    const { draft } = await f.adapter.plan(f.session, { text: [CANARY] })
    expect(draft.ops.some((op) => op.op === 'delete-file' && op.store.path.endsWith(`codeword-${CANARY}.md`))).toBe(true)
    applyPlan(buildPlan(new Store(join(f.base, '.unremember')), draft, { text: [CANARY] }), new Store(join(f.base, '.unremember')))
    const index = readFileSync(join(f.project, 'memory', 'MEMORY.md'), 'utf8')
    expect(index).toContain('not-secret.md')
    expect(index).toContain('secret.md')
    expect(index).not.toContain(`codeword-${CANARY}.md`)
    expect(existsSync(join(f.project, 'memory', `codeword-${CANARY}.md`))).toBe(false)
  })
})
