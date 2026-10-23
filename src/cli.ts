#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { Store } from './store.js'

const USAGE = `unremember — 让 agent 真的忘掉一件事

用法：
  unremember sessions [--platform cc|dsh] [--cwd <目录>]
  unremember plan <会话> (--text <内容>... | --message <id>... | --about <描述>) [--semantic] [--json]
  unremember apply <plan-id> [--yes]
  unremember verify <会话> --canary <内容>... [--probes 20] [--semantic]
  unremember resume <会话>
  unremember rollback <plan-id>
  unremember backups
  unremember purge-backups [<plan-id>] --yes

<会话> 可以是会话 id、id 前缀，或 last（当前目录下最近的一个会话）。
默认只做 dry-run；所有改动都会先备份，可以用 rollback 还原。`

function main(argv: string[]): number {
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
      semantic: { type: 'boolean' },
      json: { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  if (!command || values.help) {
    console.log(USAGE)
    return command ? 0 : 1
  }
  const store = new Store()
  switch (command) {
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
    case 'sessions':
    case 'plan':
    case 'apply':
    case 'verify':
    case 'resume':
      return fail(`\`${command}\` 还没实现。`)
    default:
      console.error(USAGE)
      return fail(`未知命令：${command}`)
  }
}

function fail(message: string): number {
  console.error(message)
  return 1
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
