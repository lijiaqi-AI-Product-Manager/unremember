import { describe, expect, it } from 'vitest'
import { renderDshResume } from '../src/resume.js'

describe('dsh resume command rendering', () => {
  it('quotes cwd and session id before substituting shell placeholders', () => {
    const rendered = renderDshResume('dsh --session {sessionId} --cwd {cwd}', 's; touch /tmp/pwned', '/tmp/a; touch /tmp/pwned')
    if (process.platform === 'win32') {
      expect(rendered).toContain('"s; touch /tmp/pwned"')
      expect(rendered).toContain('"/tmp/a; touch /tmp/pwned"')
    } else {
      expect(rendered).toContain("'s; touch /tmp/pwned'")
      expect(rendered).toContain("'/tmp/a; touch /tmp/pwned'")
    }
  })
})
