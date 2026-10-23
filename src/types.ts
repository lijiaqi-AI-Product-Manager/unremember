export type Platform = 'claude-code' | 'dsh'

export type StoreKind =
  | 'cc-transcript'
  | 'cc-subagent'
  | 'cc-history'
  | 'cc-memory'
  | 'cc-memory-index'
  | 'cc-file-history'
  | 'cc-paste-cache'
  | 'cc-tool-result'
  | 'dsh-session'
  | 'dsh-session-old-gen'
  | 'dsh-storage'
  | 'dsh-attachment'

export interface StoreRef {
  kind: StoreKind
  path: string
}

export interface SessionRef {
  platform: Platform
  sessionId: string
  /** The live session file (transcript / current generation). */
  file: string
  projectDir?: string
  /** The session working directory, when the format carries one. */
  cwd?: string
}

export interface SessionInfo extends SessionRef {
  startedAt?: number
  updatedAt?: number
  /** First user prompt, truncated; shown only in the terminal. */
  preview?: string
}

export type LiveState = 'live' | 'idle' | 'unknown'

export interface Target {
  /** Literal variants, e.g. the full secret and its distinctive parts. */
  text?: string[]
  /** Claude entry uuids or dsh seqs. */
  messageIds?: string[]
  /** Natural-language description; only used by semantic locate. */
  about?: string
}

export interface Locator {
  /** 0-based line in a JSONL or text file. */
  line?: number
  /** JSON pointer inside the line's object. */
  pointer?: string
  /** Character span inside the string at `pointer` (or inside the line for text files). */
  start?: number
  end?: number
}

export interface Hit {
  store: StoreRef
  locator: Locator
  how: 'exact' | 'semantic' | 'dependency'
  confidence: number
  /** Masked context, terminal only; never persisted. */
  excerpt?: string
  reason?: string
}

interface OpBase {
  store: StoreRef
  reason: string
}

export type Op =
  | (OpBase & { op: 'delete-entry'; line: number })
  | (OpBase & { op: 'delete-line'; line: number })
  | (OpBase & { op: 'delete-file' })
  | (OpBase & { op: 'redact-span'; line?: number; pointer?: string; start: number; end: number; replacement: string })
  | (OpBase & { op: 'blank-field'; line: number; pointer: string; value: '' | [] | Record<string, never> })
  | (OpBase & { op: 'set-field'; line: number; pointer: string; value: unknown })
  /** Remove one element of an array, e.g. a thinking block from message.content. */
  | (OpBase & { op: 'remove-element'; line: number; pointer: string })
  | (OpBase & { op: 'relink'; line: number; pointer: string; from: string | null; to: string | null })

export interface FormatFingerprint {
  platform: Platform
  versions: string[]
  entryTypes: Record<string, number>
  /** Entry types this build has not been taught; a hit inside one blocks apply. */
  unknownTypes: string[]
}

export interface Plan {
  v: 1
  id: string
  createdAt: number
  session: SessionRef
  /** sha256 of each literal target variant; the plaintext is never written to disk. */
  targetSha256: string[]
  fingerprint: FormatFingerprint
  ops: Op[]
  /** Every file the ops touch, as it was when planned; apply refuses if any changed. */
  files: Array<{ path: string; sha256Before: string | null }>
  warnings: string[]
  /** Reasons apply must refuse, e.g. a hit inside an entry type we don't understand. */
  blockers: string[]
  /** Exact hits left after simulating the ops on the session's own files; must be 0. */
  residualHits: number
}

export type PlanDraft = Omit<Plan, 'v' | 'id' | 'createdAt' | 'targetSha256'>

export interface PlanOptions {
  semantic?: boolean
  /** 'turn' deletes every turn whose prompt mentions the target; 'span' only cuts the matched text. */
  scope?: 'turn' | 'span'
}

export interface Adapter {
  platform: Platform
  listSessions(options: { cwd?: string }): SessionInfo[]
  resolveSession(query: string, options: { cwd?: string }): SessionRef | undefined
  liveState(session: SessionRef): LiveState
  stores(session: SessionRef): StoreRef[]
  plan(session: SessionRef, target: Target, options: PlanOptions): Promise<{ draft: PlanDraft; hits: Hit[] }>
  apply(plan: Plan): void
}
