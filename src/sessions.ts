import { ClaudeAdapter } from './claude.js'
import { DshAdapter } from './dsh.js'
import type { Adapter, Platform, SessionInfo, SessionRef } from './types.js'

export function adapters(platform?: Platform): Adapter[] {
  if (platform === 'claude-code') return [new ClaudeAdapter()]
  if (platform === 'dsh') return [new DshAdapter()]
  return [new ClaudeAdapter(), new DshAdapter()]
}

export function listSessions(options: { platform?: Platform; cwd?: string } = {}): SessionInfo[] {
  const out: SessionInfo[] = []
  for (const adapter of adapters(options.platform)) out.push(...adapter.listSessions({ cwd: options.cwd }))
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return out
}

export function findSession(
  query: string,
  options: { platform?: Platform; cwd?: string } = {},
): { session: SessionRef; adapter: Adapter } {
  if (query === 'last' && options.platform === undefined) {
    const latest = listSessions({ cwd: options.cwd })[0]
    if (!latest) throw new Error('找不到会话 "last"')
    const adapter = latest.platform === 'claude-code' ? adapters('claude-code')[0]! : adapters('dsh')[0]!
    return { session: latest, adapter }
  }
  const candidates = adapters(options.platform)
  const errors: string[] = []
  for (const adapter of candidates) {
    try {
      const session = adapter.resolveSession(query, { cwd: options.cwd })
      if (session) return { session, adapter }
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  throw new Error(`找不到会话 "${query}"`)
}
