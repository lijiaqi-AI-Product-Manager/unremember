import { spawnSync } from 'node:child_process'
import { applyPlan } from './apply.js'
import { buildPlan, formatPlan } from './plan.js'
import { ClaudeAdapter } from './claude.js'
import { DshAdapter } from './dsh.js'
import type { Store } from './store.js'
import type { SessionRef } from './types.js'

export async function resumeSession(session: SessionRef, opts: { yes?: boolean; store: Store }): Promise<number> {
  const pending = opts.store.loadPending(session.sessionId) ?? opts.store.listPending().find((p) => p.sessionId === session.sessionId)
  if (!pending) {
    console.error(`没有待办遗忘请求 ${session.sessionId}。skill 应先把请求写到 ~/.unremember/pending/。`)
    return 1
  }
  const adapter = session.platform === 'claude-code' ? new ClaudeAdapter() : new DshAdapter()
  const semantic = Boolean(pending.target.about && !pending.target.text?.length && !pending.target.messageIds?.length)
  const { draft } = await adapter.plan(session, pending.target, { scope: 'turn', semantic })
  const plan = buildPlan(opts.store, draft, pending.target)
  opts.store.savePlan(plan)
  if (!opts.yes) {
    console.log(formatPlan(plan))
    console.log('\n确认执行请加 --yes；执行后会恢复会话。')
    return 1
  }
  if (plan.blockers.length) {
    console.error(`计划有 blockers，拒绝执行：\n  ${plan.blockers.join('\n  ')}`)
    return 1
  }
  applyPlan(plan, opts.store)
  opts.store.removePending(session.sessionId)
  console.log(`已完成遗忘 ${plan.id}。`)
  if (session.platform === 'claude-code') {
    const command = process.env.CLAUDE_BIN || 'claude'
    const r = spawnSync(command, ['--resume', session.sessionId], {
      cwd: session.cwd ?? session.projectDir ?? process.cwd(),
      env: process.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    return r.status ?? 1
  }
  const template = process.env.UNREMEMBER_DSH_RESUME_CMD?.trim()
  if (template) {
    const command = template
      .replaceAll('{sessionId}', session.sessionId)
      .replaceAll('{cwd}', session.cwd ?? process.cwd())
    console.log(`dsh 恢复：${command}`)
    const r = spawnSync(command, {
      cwd: session.cwd ?? process.cwd(),
      env: { ...process.env, UNREMEMBER_SESSION_ID: session.sessionId },
      stdio: 'inherit',
      shell: true,
    })
    return r.status ?? 1
  }
  console.log(`dsh 的恢复命令：dsh --profile ${process.env.DSH_PROFILE || 'web'} --session-id ${session.sessionId}`)
  console.log('提示：设置 UNREMEMBER_DSH_RESUME_CMD 可让 resume 直接执行你的 dsh 启动器；支持 {sessionId} / {cwd} 占位符。')
  return 0
}
