import { sha256 } from './fsx.js'
import { Store } from './store.js'
import type { Plan, PlanDraft, SessionRef, Target } from './types.js'

export function buildPlan(store: Store, draft: PlanDraft, target: Target): Plan {
  return {
    v: 1,
    id: store.newPlanId(),
    createdAt: Date.now(),
    session: draft.session,
    targetSha256: [...(target.text ?? [])].map((text) => sha256(text)),
    fingerprint: draft.fingerprint,
    ops: draft.ops,
    files: draft.files,
    warnings: draft.warnings,
    blockers: draft.blockers,
    residualHits: draft.residualHits,
  }
}

export function summarizeTarget(target: Target): string {
  const parts = [
    target.text?.length ? `${target.text.length} 个字面变体` : undefined,
    target.messageIds?.length ? `${target.messageIds.length} 个 message/seq` : undefined,
    target.about ? '自然语言描述' : undefined,
  ].filter(Boolean)
  return parts.join(' + ') || '空目标'
}

export function maskId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

export function sessionLabel(session: SessionRef): string {
  return `${session.platform}:${session.sessionId}`
}

export function formatPlan(plan: Plan): string {
  const lines: string[] = []
  lines.push(`plan ${plan.id}`)
  lines.push(`session ${sessionLabel(plan.session)}`)
  lines.push(`format ${plan.fingerprint.platform} ${plan.fingerprint.versions.join(',') || 'version?'}`)
  lines.push(`ops ${plan.ops.length}  files ${plan.files.length}  residual ${plan.residualHits}`)
  if (plan.blockers.length) {
    lines.push('blockers:')
    for (const b of plan.blockers) lines.push(`  ! ${b}`)
  }
  if (plan.warnings.length) {
    lines.push('warnings:')
    for (const w of plan.warnings) lines.push(`  ? ${w}`)
  }
  const byStore = new Map<string, Plan['ops']>()
  for (const op of plan.ops) byStore.set(op.store.path, [...(byStore.get(op.store.path) ?? []), op])
  for (const [path, ops] of byStore) {
    lines.push(`${path}`)
    for (const op of ops) {
      const line = 'line' in op && op.line !== undefined ? `:${op.line + 1}` : ''
      if (op.op === 'delete-file') lines.push(`  - delete file`)
      else if (op.op === 'delete-entry' || op.op === 'delete-line') lines.push(`  - delete ${line}`)
      else if (op.op === 'redact-span') lines.push(`  ~ redact ${line}${op.pointer ?? ''}`)
      else if (op.op === 'blank-field') lines.push(`  ~ blank ${line}${op.pointer}`)
      else if (op.op === 'set-field') lines.push(`  ~ set ${line}${op.pointer}`)
      else if (op.op === 'remove-element') lines.push(`  - remove ${line}${op.pointer}`)
      else if (op.op === 'relink') lines.push(`  → relink ${line}${op.pointer}`)
    }
  }
  return lines.join('\n')
}
