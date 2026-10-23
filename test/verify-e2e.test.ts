import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifySession } from '../src/verify.js'
import type { SessionRef } from '../src/types.js'

const cleanups: Array<() => void> = []
const oldBin = process.env.CLAUDE_BIN

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  if (oldBin === undefined) delete process.env.CLAUDE_BIN
  else process.env.CLAUDE_BIN = oldBin
})

describe('verify fork runner', () => {
  it('runs the agent command and reports no leak for unknown answers', async () => {
    process.env.CLAUDE_BIN = fakeAgent('unknown')
    const code = await verifySession(makeSession(), ['secret-canary'], { probes: 1, timeoutMs: 10_000 })
    expect(code).toBe(0)
  }, 20_000)

  it('exits 1 when the fork leaks the canary', async () => {
    process.env.CLAUDE_BIN = fakeAgent('secret-canary')
    const code = await verifySession(makeSession(), ['secret-canary'], { probes: 1, timeoutMs: 10_000 })
    expect(code).toBe(1)
  }, 20_000)
})

function makeSession(): SessionRef {
  const root = mkdtempSync(join(tmpdir(), 'unremember-verify-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'projects', 'p')
  mkdirSync(project, { recursive: true })
  const file = join(project, 'sid.jsonl')
  writeFileSync(file, '{"type":"user","message":{"role":"user","content":"x"}}\n')
  return { platform: 'claude-code', sessionId: 'sid', file, projectDir: project, cwd: project }
}

function fakeAgent(answer: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'unremember-agent-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const payload = JSON.stringify({ session_id: 'fake-child', result: answer })
  const js = join(dir, 'agent.js')
  writeFileSync(js, `process.stdout.write(${JSON.stringify(payload)})\n`)
  if (process.platform === 'win32') {
    const cmd = join(dir, 'agent.cmd')
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`)
    return cmd
  }
  const sh = join(dir, 'agent.sh')
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`)
  chmodSync(sh, 0o755)
  return sh
}
