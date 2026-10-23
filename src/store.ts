// unremember's own state under ~/.unremember: plans, backups, pending requests and a journal.
// None of it holds the forgotten text except backups (undo) and a 0600 pending request (skill input).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { sha256File, writeAtomic } from './fsx.js'
import { dataHome } from './paths.js'
import type { Plan, Platform, Target } from './types.js'

export interface BackupManifest {
  v: 1
  planId: string
  createdAt: number
  encrypted?: boolean
  salt?: string
  files: Array<{ path: string; sha256: string | null; copy?: string; iv?: string; tag?: string }>
}

export interface JournalEntry {
  t: number
  action: 'apply' | 'rollback' | 'purge'
  planId: string
  files: number
  ops?: number
}

export interface PendingRequest {
  v: 1
  platform: Platform
  sessionId: string
  createdAt: number
  /** Literal target variants; stored 0600 under pending/, never in a plan. */
  target: Target
}

export class Store {
  readonly dir: string
  constructor(dir = dataHome()) {
    this.dir = dir
  }

  newPlanId(now = Date.now()): string {
    const d = new Date(now)
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return `${stamp}-${randomBytes(2).toString('hex')}`
  }

  private planFile(id: string) {
    if (!safeSegment(id)) throw new Error(`invalid plan id: ${id}`)
    return join(this.dir, 'plans', `${id}.json`)
  }

  private backupDir(id: string) {
    if (!safeSegment(id)) throw new Error(`invalid plan id: ${id}`)
    return join(this.dir, 'backups', id)
  }

  private pendingFile(sessionId: string) {
    return join(this.dir, 'pending', `${safeSessionSegment(sessionId)}.json`)
  }

  savePlan(plan: Plan) {
    writeAtomic(this.planFile(plan.id), JSON.stringify(plan, null, 1))
  }

  loadPlan(id: string): Plan | undefined {
    try {
      return JSON.parse(readFileSync(this.planFile(id), 'utf8')) as Plan
    } catch {
      return undefined
    }
  }

  /** Copy every file (or record its absence) before apply touches it. */
  backup(planId: string, paths: string[], now = Date.now()): BackupManifest {
    const dir = this.backupDir(planId)
    if (existsSync(join(dir, 'manifest.json'))) throw new Error(`backup for ${planId} already exists`)
    mkdirSync(join(dir, 'files'), { recursive: true })
    const passphrase = encryptionPassphrase()
    const salt = passphrase ? randomBytes(16) : undefined
    const key = passphrase && salt ? scryptSync(passphrase, salt, 32) : undefined
    const files = [...new Set(paths)].map((path, i) => {
      const sha = sha256File(path)
      if (sha === null) return { path, sha256: null }
      const copy = join('files', String(i))
      if (key) {
        const plain = readFileSync(path)
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
        writeFileSync(join(dir, copy), encrypted)
        return { path, sha256: sha, copy, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
      }
      copyFileSync(path, join(dir, copy))
      return { path, sha256: sha, copy }
    })
    const manifest: BackupManifest = { v: 1, planId, createdAt: now, ...(key ? { encrypted: true, salt: salt!.toString('base64') } : {}), files }
    writeAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1))
    return manifest
  }

  readManifest(planId: string): BackupManifest | undefined {
    try {
      return JSON.parse(readFileSync(join(this.backupDir(planId), 'manifest.json'), 'utf8')) as BackupManifest
    } catch {
      return undefined
    }
  }

  /** Put every file back as it was; returns paths whose restored hash did not match. */
  restore(planId: string): { restored: string[]; mismatched: string[] } {
    const manifest = this.readManifest(planId)
    if (!manifest) throw new Error(`no backup for ${planId}`)
    const restored: string[] = []
    const mismatched: string[] = []
    for (const f of manifest.files) {
      if (f.sha256 === null) {
        rmSync(f.path, { force: true })
      } else {
        const raw = readFileSync(join(this.backupDir(planId), f.copy!))
        const plain = manifest.encrypted ? decryptBackup(raw, manifest, f) : raw
        writeAtomic(f.path, plain)
        if (sha256File(f.path) !== f.sha256) mismatched.push(f.path)
      }
      restored.push(f.path)
    }
    return { restored, mismatched }
  }

  listBackups(): BackupManifest[] {
    const root = join(this.dir, 'backups')
    if (!existsSync(root)) return []
    return readdirSync(root)
      .map((id) => this.readManifest(id))
      .filter((m): m is BackupManifest => m !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  purgeBackup(planId: string) {
    rmSync(this.backupDir(planId), { recursive: true, force: true })
  }

  journal(entry: JournalEntry) {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(join(this.dir, 'journal.jsonl'), JSON.stringify(entry) + '\n')
  }

  /** A skill writes this while the session is still live; resume consumes it. */
  savePending(request: PendingRequest) {
    const file = this.pendingFile(request.sessionId)
    mkdirSync(join(this.dir, 'pending'), { recursive: true })
    const plain = Buffer.from(JSON.stringify(request, null, 1), 'utf8')
    const passphrase = encryptionPassphrase()
    if (passphrase) {
      const salt = randomBytes(16)
      const key = scryptSync(passphrase, salt, 32)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
      const wrapper = {
        v: 2,
        encrypted: true,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        payload: encrypted.toString('base64'),
      }
      writeAtomic(file, JSON.stringify(wrapper, null, 1))
    } else {
      writeAtomic(file, JSON.stringify(request, null, 1))
    }
    try {
      chmodSync(file, 0o600)
    } catch {}
  }

  loadPending(sessionId: string): PendingRequest | undefined {
    return readPendingFile(this.pendingFile(sessionId))
  }

  removePending(sessionId: string) {
    rmSync(this.pendingFile(sessionId), { force: true })
  }

  listPending(): PendingRequest[] {
    const dir = join(this.dir, 'pending')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readPendingFile(join(dir, f)))
      .filter((p): p is PendingRequest => p !== undefined)
  }
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value)
}

function safeSessionSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

function encryptionPassphrase(): string | undefined {
  const direct = process.env.UNREMEMBER_ENCRYPTION_KEY?.trim()
  if (direct) return direct
  const file = process.env.UNREMEMBER_ENCRYPTION_KEY_FILE?.trim()
  if (!file) return undefined
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch {
    throw new Error('UNREMEMBER_ENCRYPTION_KEY_FILE 不可读')
  }
}

function decryptBackup(raw: Buffer, manifest: BackupManifest, f: BackupManifest['files'][number]): Buffer {
  const salt = manifest.salt
  if (!salt || !f.iv || !f.tag) throw new Error('备份加密元数据不完整')
  const passphrase = encryptionPassphrase()
  if (!passphrase) throw new Error('备份已加密：请设置 UNREMEMBER_ENCRYPTION_KEY')
  try {
    const key = scryptSync(passphrase, Buffer.from(salt, 'base64'), 32)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(f.tag, 'base64'))
    return Buffer.concat([decipher.update(raw), decipher.final()])
  } catch {
    throw new Error('备份解密失败：密钥错误或备份已损坏')
  }
}

function readPendingFile(file: string): PendingRequest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
    if (parsed?.encrypted === true && typeof parsed.payload === 'string') {
      const passphrase = encryptionPassphrase()
      if (!passphrase) return undefined
      const key = scryptSync(passphrase, Buffer.from(String(parsed.salt), 'base64'), 32)
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(parsed.iv), 'base64'))
      decipher.setAuthTag(Buffer.from(String(parsed.tag), 'base64'))
      const plain = Buffer.concat([decipher.update(Buffer.from(parsed.payload, 'base64')), decipher.final()]).toString('utf8')
      return JSON.parse(plain) as PendingRequest
    }
    return parsed as PendingRequest
  } catch {
    return undefined
  }
}
