import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'unremember-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
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
