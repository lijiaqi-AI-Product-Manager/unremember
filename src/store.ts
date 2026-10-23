// unremember's own state under ~/.unremember: plans, backups, pending requests and a journal.
// None of it holds the forgotten text except backups (undo) and a 0600 pending request (skill input).
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { sha256File, writeAtomic } from './fsx.js'
import { dataHome } from './paths.js'
import type { Plan, Platform, Target } from './types.js'

export interface BackupManifest {
  v: 1
  planId: string
  createdAt: number
  files: Array<{ path: string; sha256: string | null; copy?: string }>
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
    const files = [...new Set(paths)].map((path, i) => {
      const sha = sha256File(path)
      if (sha === null) return { path, sha256: null }
      const copy = join('files', String(i))
      copyFileSync(path, join(dir, copy))
      return { path, sha256: sha, copy }
    })
    const manifest: BackupManifest = { v: 1, planId, createdAt: now, files }
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
        writeAtomic(f.path, readFileSync(join(this.backupDir(planId), f.copy!)))
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
    writeAtomic(file, JSON.stringify(request, null, 1))
    try {
      chmodSync(file, 0o600)
    } catch {}
  }

  loadPending(sessionId: string): PendingRequest | undefined {
    try {
      return JSON.parse(readFileSync(this.pendingFile(sessionId), 'utf8')) as PendingRequest
    } catch {
      return undefined
    }
  }

  removePending(sessionId: string) {
    rmSync(this.pendingFile(sessionId), { force: true })
  }

  listPending(): PendingRequest[] {
    const dir = join(this.dir, 'pending')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf8')) as PendingRequest
        } catch {
          return undefined
        }
      })
      .filter((p): p is PendingRequest => p !== undefined)
  }
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value)
}

function safeSessionSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}
