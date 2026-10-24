#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { applyPlan } from './apply.js'
import { buildPlan, formatPlan } from './plan.js'
import { findSession, listSessions } from './sessions.js'
import { Store } from './store.js'
import { claudeConfigDir, dshHome } from './paths.js'
import { semanticConfig } from './semantic.js'
import { mask } from './text.js'
import type { Platform, PlanOptions, Target } from './types.js'
import { verifySession } from './verify.js'
import { resumeSession } from './resume.js'

const VERSION = '1.0.3'

const USAGE = `unremember — 让 agent 真的忘掉一件事

用法：
  unremember doctor
  unremember sessions [--platform cc|dsh] [--cwd <目录>] [--json] [--show-preview]
  unremember pending <会话> (--text <内容>... | --message <id>... | --about <描述>)
  unremember plan <会话> (--text <内容>... | --message <id>... | --about <描述>) [--scope turn|span] [--semantic] [--json]
  unremember plans
  unremember purge-plans [<plan-id>] --yes
  unremember apply <plan-id> [--yes]
  unremember verify <会话> --canary <内容>... [--probes 20] [--semantic]
  unremember resume <会话> [--yes]
  unremember rollback <plan-id>
  unremember backups
  unremember purge-backups [<plan-id>] --yes

<会话> 可以是会话 id、id 前缀、transcript 路径，或 last（当前目录下最近的一个会话）。
默认只做 dry-run；所有改动都会先备份，可以用 rollback 还原。
`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      platform: { type: 'string' },
      cwd: { type: 'string' },
      text: { type: 'string', multiple: true },
      message: { type: 'string', multiple: true },
      about: { type: 'string' },
      canary: { type: 'string', multiple: true },
      probes: { type: 'string' },
      scope: { type: 'string' },
      semantic: { type: 'boolean' },
      json: { type: 'boolean' },
      'show-preview': { type: 'boolean' },
      yes: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.version) {
    console.log(`unremember ${VERSION}`)
    return 0
  }
  const [command, ...rest] = positionals
  if (!command) {
    console.log(USAGE)
    return values.help ? 0 : 1
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const store = new Store()
  switch (command) {
    case 'sessions': {
      const platform = parsePlatform(values.platform)
      const list = listSessions({ platform, cwd: values.cwd })
      if (values.json) {
        const safe = list.map(({ preview, ...rest }) => (values['show-preview'] ? { ...rest, preview } : rest))
        console.log(JSON.stringify(safe, null, 2))
        return 0
      }
      if (!list.length) {
        console.log('没有找到会话。')
        return 0
      }
      for (const s of list) {
        const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '时间未知'
        console.log(`${s.platform.padEnd(10)} ${s.sessionId}  ${when}`)
        if (s.preview) console.log(`  ${values['show-preview'] ? s.preview : mask(s.preview)}`)
        if (s.projectDir) console.log(`  ${s.projectDir}`)
      }
      return 0
    }
    case 'doctor': {
      console.log(`unremember ${VERSION}`)
      console.log(`node       ${process.version}  ${process.platform}/${process.arch}`)
      console.log(`claude dir ${claudeConfigDir()}`)
      console.log(`dsh home   ${dshHome()}`)
      console.log(`semantic   ${semanticConfig() ? 'configured' : 'off'}`)
      console.log(`encryption ${process.env.UNREMEMBER_ENCRYPTION_KEY || process.env.UNREMEMBER_ENCRYPTION_KEY_FILE ? 'on' : 'off'}`)
      console.log(`backups    ${store.listBackups().length}`)
      try {
        const all = listSessions({})
        console.log(`sessions   ${all.length}`)
      } catch (e) {
        console.log(`sessions   error: ${e instanceof Error ? e.message : String(e)}`)
      }
      console.log(`dsh resume ${process.env.UNREMEMBER_DSH_RESUME_CMD ? 'configured' : 'hint only'}`)
      return 0
    }
    case 'pending': {
      const query = rest[0]
      if (!query) return fail('需要会话 id、前缀或 last。')
      const target = parseTarget(values)
      const platform = parsePlatform(values.platform)
      const { session } = findSession(query, { platform, cwd: values.cwd })
      store.savePending({ v: 1, platform: session.platform, sessionId: session.sessionId, createdAt: Date.now(), target })
      console.log(`待办已写：${store.dir}/pending/${session.sessionId}.json`)
      console.log(`退出当前会话后运行：unremember resume ${session.sessionId} --yes`)
      return 0
    }
    case 'plan': {
      const query = rest[0]
      if (!query) return fail('需要会话 id、前缀或 last。')
      const target = parseTarget(values)
      const platform = parsePlatform(values.platform)
      const { session, adapter } = findSession(query, { platform, cwd: values.cwd })
      const scope = values.scope === undefined ? 'turn' : values.scope
      if (scope !== 'turn' && scope !== 'span') return fail('--scope 只能是 turn 或 span。')
      if (values.semantic && !values.yes) {
        console.error('--semantic 会把目标/字面提示（含 canary 原文）和候选摘录发送到配置的模型接口。检查环境变量后加 --yes 确认。')
        return 1
      }
      const options: PlanOptions = { semantic: values.semantic, scope }
      const { draft, hits } = await adapter.plan(session, target, options)
      const plan = buildPlan(store, draft, target)
      store.savePlan(plan)
      if (values.json) {
        console.log(JSON.stringify(plan, null, 2))
      } else {
        console.log(formatPlan(plan))
        console.log(`\n命中 ${hits.length} 处（只显示脱敏摘录）：`)
        const byStore = new Map<string, number>()
        for (const h of hits) byStore.set(h.store.path, (byStore.get(h.store.path) ?? 0) + 1)
        for (const [path, n] of byStore) console.log(`  ${n}  ${path}`)
        for (const h of hits.slice(0, 20)) console.log(`  ${h.store.kind} ${h.excerpt ?? ''}`)
        console.log(`\n计划已写：~/.unremember/plans/${plan.id}.json`)
        if (plan.blockers.length) console.log('存在 blockers；apply 会拒绝执行。')
      }
      return plan.blockers.length ? 1 : 0
    }
    case 'plans': {
      const ids = store.listPlans()
      if (!ids.length) console.log('没有计划。')
      else for (const id of ids) console.log(id)
      return 0
    }
    case 'purge-plans': {
      const ids = rest[0] ? [rest[0]] : store.listPlans()
      if (!ids.length) {
        console.log('没有计划。')
        return 0
      }
      if (!values.yes) return fail(`将永久删除 ${ids.length} 份计划；确认请加 --yes。`)
      for (const id of ids) store.purgePlan(id)
      console.log(`已删除 ${ids.length} 份计划。`)
      return 0
    }
    case 'apply': {
      const id = rest[0]
      if (!id) return fail('需要 plan-id。')
      const plan = store.loadPlan(id)
      if (!plan) return fail(`找不到计划 ${id}。`)
      if (!values.yes) {
        console.log(formatPlan(plan))
        console.log('\n这只是 dry-run；确认执行请加 --yes。')
        return 1
      }
      if (plan.blockers.length) return fail(`计划有 blockers，拒绝执行：\n  ${plan.blockers.join('\n  ')}`)
      applyPlan(plan, store)
      console.log(`已执行 ${plan.id}：${plan.ops.length} 个操作，${plan.files.length} 个文件。`)
      console.log('可以用 `unremember rollback ' + plan.id + '` 还原，或 `unremember purge-backups` 删除备份。')
      return 0
    }
    case 'verify': {
      const query = rest[0]
      if (!query) return fail('需要会话 id、前缀或 last。')
      const canaries = (values.canary ?? []).filter(Boolean)
      if (!canaries.length) return fail('至少需要一个 --canary。')
      const count = values.probes === undefined ? 20 : Number(values.probes)
      if (!Number.isInteger(count) || count <= 0) return fail('--probes 必须是正整数。')
      const platform = parsePlatform(values.platform)
      const { session } = findSession(query, { platform, cwd: values.cwd })
      return verifySession(session, canaries, { probes: count, semantic: values.semantic })
    }
    case 'resume': {
      const query = rest[0]
      if (!query) return fail('需要会话 id、前缀或 last。')
      const platform = parsePlatform(values.platform)
      const { session } = findSession(query, { platform, cwd: values.cwd })
      return resumeSession(session, { yes: values.yes, store })
    }
    case 'rollback': {
      const id = rest[0]
      if (!id) return fail('需要 plan-id。用 `unremember backups` 查看。')
      const { restored, mismatched } = store.restore(id)
      store.journal({ t: Date.now(), action: 'rollback', planId: id, files: restored.length })
      console.log(`已还原 ${restored.length} 个文件。`)
      if (mismatched.length) return fail(`以下文件还原后哈希不一致：\n  ${mismatched.join('\n  ')}`)
      return 0
    }
    case 'backups': {
      const list = store.listBackups()
      if (!list.length) console.log('没有备份。')
      for (const m of list) console.log(`${m.planId}  ${new Date(m.createdAt).toLocaleString()}  ${m.files.length} 个文件`)
      return 0
    }
    case 'purge-backups': {
      const ids = rest[0] ? [rest[0]] : store.listBackups().map((m) => m.planId)
      if (!ids.length) {
        console.log('没有备份。')
        return 0
      }
      if (!values.yes) return fail(`将永久删除 ${ids.length} 份备份（删除后无法 rollback）。确认请加 --yes。`)
      for (const id of ids) {
        store.purgeBackup(id)
        store.journal({ t: Date.now(), action: 'purge', planId: id, files: 0 })
      }
      console.log(`已删除 ${ids.length} 份备份。`)
      return 0
    }
    default:
      console.error(USAGE)
      return fail(`未知命令：${command}`)
  }
}

function parsePlatform(value: string | undefined): Platform | undefined {
  if (value === undefined) return undefined
  if (value === 'cc' || value === 'claude' || value === 'claude-code') return 'claude-code'
  if (value === 'dsh') return 'dsh'
  throw new Error('--platform 只能是 cc 或 dsh。')
}

function parseTarget(values: { text?: string[]; message?: string[]; about?: string }): Target {
  const target: Target = {}
  if (values.text?.length) target.text = values.text
  if (values.message?.length) target.messageIds = values.message
  if (values.about) target.about = values.about
  if (!target.text?.length && !target.messageIds?.length && !target.about) {
    throw new Error('需要 --text、--message 或 --about。')
  }
  return target
}

function fail(message: string): number {
  console.error(message)
  return 1
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
