import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { semanticConfig, semanticJudge, semanticLocate } from '../src/semantic.js'
import type { SessionRef, StoreRef } from '../src/types.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  delete process.env.UNREMEMBER_SEMANTIC_BASE_URL
  delete process.env.UNREMEMBER_SEMANTIC_MODEL
  delete process.env.UNREMEMBER_SEMANTIC_API_KEY
})

describe('semantic provider', () => {
  it('requires a base URL and model', () => {
    expect(semanticConfig({})).toBeUndefined()
    expect(semanticConfig({ UNREMEMBER_SEMANTIC_BASE_URL: 'http://localhost:1', UNREMEMBER_SEMANTIC_MODEL: 'm' })).toMatchObject({
      baseUrl: 'http://localhost:1',
      model: 'm',
    })
  })

  it('locates an exact quote in a text store and judges a leak', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unremember-sem-'))
    const file = join(dir, 'memory.md')
    writeFileSync(file, 'prefix secret-canary suffix\n')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string }> }
        const user = payload.messages.find((m) => m.role === 'user')?.content ?? ''
        const content = user.includes('"target":"secret-canary"')
          ? JSON.stringify({ leak: true, reason: 'test' })
          : JSON.stringify({ hits: [{ id: 'c0', quote: 'secret-canary', confidence: 1 }] })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => server.close())
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no test server port')
    process.env.UNREMEMBER_SEMANTIC_BASE_URL = `http://127.0.0.1:${address.port}/v1`
    process.env.UNREMEMBER_SEMANTIC_MODEL = 'test-model'

    const store: StoreRef = { kind: 'cc-memory', path: file }
    const session: SessionRef = { platform: 'claude-code', sessionId: 's', file: join(dir, 'x.jsonl') }
    const hits = await semanticLocate(session, [store], 'the canary', [])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.start).toBe(7)
    expect(hits[0]!.end).toBe(7 + 'secret-canary'.length)
    expect(await semanticJudge('secret-canary', 'secret-canary')).toBe(true)
  })
})
