import { dirname } from 'node:path'
import { ClaudeAdapter } from './claude.js'
import { DshAdapter } from './dsh.js'
import { Store } from './store.js'
import { applyPlanWithLive } from './apply-core.js'
import type { Plan } from './types.js'

export { isJsonlKind } from './apply-core.js'

export function applyPlan(plan: Plan, store = new Store()): void {
  const root = plan.session.platform === 'claude-code'
    ? dirname(dirname(dirname(plan.session.file)))
    : dirname(dirname(dirname(dirname(plan.session.file))))
  const adapter = plan.session.platform === 'claude-code' ? new ClaudeAdapter(root) : new DshAdapter(root)
  const allowed = adapter.stores(plan.session).map((s) => s.path)
  applyPlanWithLive(plan, store, (session) => adapter.liveState(session), [...allowed, plan.session.file])
}
