import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store.js'

const dirs: string[] = []
const oldKey = process.env.UNREMEMBER_ENCRYPTION_KEY
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'unremember-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (oldKey === undefined) delete process.env.UNREMEMBER_ENCRYPTION_KEY
  else process.env.UNREMEMBER_ENCRYPTION_KEY = oldKey
})

describe('Store backups', () => {
  it('restores edited and deleted files, and removes files that did not exist', () => {
    const work = tmp()
    const store = new Store(tmp())
    const a = join(work, 'a.jsonl')
    const b = join(work, 'b.md')
    const c = join(work, 'new.txt')
    writeFileSync(a, 'original a\n')
    writeFileSync(b, 'original b\n')
    const id = store.newPlanId()
    store.backup(id, [a, b, c])

    writeFileSync(a, 'edited\n')
    rmSync(b)
    writeFileSync(c, 'created by apply\n')

    const { restored, mismatched } = store.restore(id)
    expect(restored).toHaveLength(3)
    expect(mismatched).toEqual([])
    expect(readFileSync(a, 'utf8')).toBe('original a\n')
    expect(readFileSync(b, 'utf8')).toBe('original b\n')
    expect(existsSync(c)).toBe(false)
  })


  it('encrypts backups and pending requests when a key is configured', () => {
    process.env.UNREMEMBER_ENCRYPTION_KEY = 'test-passphrase'
    const work = tmp()
    const store = new Store(tmp())
    const file = join(work, 'secret.md')
    writeFileSync(file, 'the secret 青柠绿-7429\n')
    const id = store.newPlanId()
    store.backup(id, [file])
    const copy = join(store.dir, 'backups', id, 'files', '0')
    expect(readFileSync(copy, 'utf8')).not.toContain('青柠绿-7429')
    writeFileSync(file, 'gone\n')
    const { mismatched } = store.restore(id)
    expect(mismatched).toEqual([])
    expect(readFileSync(file, 'utf8')).toContain('青柠绿-7429')

    store.savePending({ v: 1, platform: 'claude-code', sessionId: 's1', createdAt: 1, target: { text: ['青柠绿-7429'] } })
    const pending = join(store.dir, 'pending', 's1.json')
    expect(readFileSync(pending, 'utf8')).not.toContain('青柠绿-7429')
    expect(store.loadPending('s1')?.target.text).toEqual(['青柠绿-7429'])
  })

  it('refuses to restore an encrypted backup with the wrong key', () => {
    process.env.UNREMEMBER_ENCRYPTION_KEY = 'right-key'
    const work = tmp()
    const store = new Store(tmp())
    const file = join(work, 'a.txt')
    writeFileSync(file, 'original\n')
    const id = store.newPlanId()
    store.backup(id, [file])
    process.env.UNREMEMBER_ENCRYPTION_KEY = 'wrong-key'
    expect(() => store.restore(id)).toThrow(/解密/)
  })

  it('refuses to overwrite an existing backup', () => {
    const store = new Store(tmp())
    const id = store.newPlanId()
    store.backup(id, [])
    expect(() => store.backup(id, [])).toThrow()
  })

  it('lists and purges', () => {
    const store = new Store(tmp())
    const id = store.newPlanId()
    store.backup(id, [])
    expect(store.listBackups().map((m) => m.planId)).toEqual([id])
    store.purgeBackup(id)
    expect(store.listBackups()).toEqual([])
  })
})
