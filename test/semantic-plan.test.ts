import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/claude.js'

const cleanups: Array<() => void> = []
const old = {
  base: process.env.UNREMEMBER_SEMANTIC_BASE_URL,
  model: process.env.UNREMEMBER_SEMANTIC_MODEL,
  key: process.env.UNREMEMBER_SEMANTIC_API_KEY,
}
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  if (old.base === undefined) delete process.env.UNREMEMBER_SEMANTIC_BASE_URL
  else process.env.UNREMEMBER_SEMANTIC_BASE_URL = old.base
  if (old.model === undefined) delete process.env.UNREMEMBER_SEMANTIC_MODEL
  else process.env.UNREMEMBER_SEMANTIC_MODEL = old.model
  if (old.key === undefined) delete process.env.UNREMEMBER_SEMANTIC_API_KEY
  else process.env.UNREMEMBER_SEMANTIC_API_KEY = old.key
})

describe('semantic plan integration', () => {
  it('turns a paraphrased memory into a redaction op without a literal --text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unremember-sem-plan-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const project = join(root, 'projects', 'C--fixture')
    mkdirSync(join(project, 'memory'), { recursive: true })
    const sid = '33333333-3333-4333-8333-333333333333'
    writeFileSync(
      join(project, `${sid}.jsonl`),
      [
        { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'remember the project code' }, sessionId: sid },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, sessionId: sid },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    )
    writeFileSync(join(project, 'memory', 'notes.md'), '# Project notes\nThe launch code is secret-canary.\n')

    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string }> }
        const outer = JSON.parse(payload.messages[1]!.content) as { candidates: Array<{ id: string; text: string }> }
        const hit = outer.candidates.find((c) => c.text.includes('secret-canary'))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ hits: hit ? [{ id: hit.id, quote: 'secret-canary', confidence: 1 }] : [] }) } }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => server.close())
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    process.env.UNREMEMBER_SEMANTIC_BASE_URL = `http://127.0.0.1:${address.port}/v1`
    process.env.UNREMEMBER_SEMANTIC_MODEL = 'test-model'

    const adapter = new ClaudeAdapter(root)
    const session = adapter.listSessions()[0]!
    const { draft } = await adapter.plan(session, { about: 'the launch code' }, { semantic: true })
    expect(draft.ops.some((op) => op.op === 'redact-span' && op.store.path.endsWith('notes.md'))).toBe(true)
    expect(draft.residualHits).toBe(0)
  })
})
