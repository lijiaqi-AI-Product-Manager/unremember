import { readFileSync, rmSync } from 'node:fs'
import { applyToJsonl, applyToText } from './ops.js'
import { JsonlFile, encodeDshLog, readDshLog, sha256File, writeAtomic } from './fsx.js'
import { Store } from './store.js'
import type { LiveState, Op, Plan, SessionRef } from './types.js'

export function isJsonlKind(kind: string, path: string): boolean {
  if (kind === 'cc-history' || kind === 'cc-transcript' || kind === 'cc-subagent') return true
  if (kind === 'dsh-session' || kind === 'dsh-session-old-gen') return true
  return path.endsWith('.jsonl')
}

export function applyPlanWithLive(
  plan: Plan,
  store: Store,
  liveState: (session: SessionRef) => LiveState,
): void {
  const live = liveState(plan.session)
  if (live !== 'idle') throw new Error(live === 'live' ? '会话正在运行，拒绝执行' : '无法确认会话是否在运行，按运行中处理')

  for (const file of plan.files) {
    const current = sha256File(file.path)
    if (current !== file.sha256Before) throw new Error(`文件在出计划后被改过：${file.path}`)
  }

  const paths = [...new Set([...plan.files.map((f) => f.path), ...plan.ops.map((op) => op.store.path)])]
  for (const path of paths) {
    if (!plan.files.some((f) => f.path === path)) throw new Error(`计划没有记录文件哈希：${path}`)
  }
  store.backup(plan.id, paths)
  const byPath = new Map<string, Op[]>()
  for (const op of plan.ops) byPath.set(op.store.path, [...(byPath.get(op.store.path) ?? []), op])

  try {
    for (const [path, ops] of byPath) {
      if (ops.some((op) => op.op === 'delete-file')) {
        rmSync(path, { force: true })
        continue
      }
      const kind = ops[0]!.store.kind
      const isDshZstd = path.endsWith('.zstd')
      const raw = isDshZstd ? readDshLog(path) : readPlain(path)
      if (raw === undefined) throw new Error(`文件不存在：${path}`)
      let out: string | null
      if (isJsonlKind(kind, path)) {
        const jsonl = new JsonlFile(raw)
        applyToJsonl(jsonl, ops)
        out = jsonl.toString()
      } else {
        out = applyToText(raw, ops)
      }
      if (out === null) {
        rmSync(path, { force: true })
        continue
      }
      writeAtomic(path, isDshZstd ? encodeDshLog(out, true) : out)
    }
  } catch (error) {
    try {
      store.restore(plan.id)
    } catch {}
    throw error
  }
  store.journal({ t: Date.now(), action: 'apply', planId: plan.id, files: paths.length, ops: plan.ops.length })
}

function readPlain(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}
