import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function sha256File(file: string): string | null {
  return existsSync(file) ? sha256(readFileSync(file)) : null
}

/** Write to a temp file and rename over the target so no reader sees half a file. */
export function writeAtomic(file: string, data: string | Buffer) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * A JSONL file edited line by line. Untouched lines are written back byte for byte, so a
 * plan only changes what it says it changes.
 */
export class JsonlFile {
  readonly raw: string[]
  readonly eol: '\n' | '\r\n'
  private readonly finalEol: boolean
  private readonly parsed = new Map<number, unknown>()
  private readonly removed = new Set<number>()
  private readonly dirty = new Set<number>()

  constructor(text: string) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n'
    this.finalEol = text.endsWith('\n')
    const lines = text.split(/\r?\n/)
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    this.raw = lines
  }

  static read(file: string): JsonlFile {
    return new JsonlFile(readFileSync(file, 'utf8'))
  }

  get length() {
    return this.raw.length
  }

  /** Parsed line, or undefined for blank or torn lines. */
  get(i: number): any {
    if (!this.parsed.has(i)) {
      let value: unknown
      try {
        value = this.raw[i]?.trim() ? JSON.parse(this.raw[i]!) : undefined
      } catch {
        value = undefined
      }
      this.parsed.set(i, value)
    }
    return this.parsed.get(i)
  }

  set(i: number, value: unknown) {
    this.parsed.set(i, value)
    this.dirty.add(i)
  }

  remove(i: number) {
    this.removed.add(i)
  }

  isRemoved(i: number) {
    return this.removed.has(i)
  }

  toString(): string {
    const out: string[] = []
    for (let i = 0; i < this.raw.length; i++) {
      if (this.removed.has(i)) continue
      out.push(this.dirty.has(i) ? JSON.stringify(this.parsed.get(i)) : this.raw[i]!)
    }
    return out.length ? out.join(this.eol) + (this.finalEol ? this.eol : '') : ''
  }
}

export function isZstd(file: string): boolean {
  return file.endsWith('.zstd')
}

export function readDshLog(file: string): string {
  const buf = readFileSync(file)
  return isZstd(file) ? decodeDshLog(buf) : buf.toString('utf8')
}

/** Decode every concatenated Zstandard frame. Node's sync decoder stops at the first frame on some platforms. */
export function decodeDshLog(buf: Buffer): string {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < buf.length) {
    if (buf.length - offset >= 4 && buf.readUInt32LE(offset) === 0xfd2fb528) {
      const length = zstdFrameLength(buf, offset)
      chunks.push(zstdDecompressSync(buf.subarray(offset, offset + length)))
      offset += length
    } else if (buf.length - offset >= 8 && (buf.readUInt32LE(offset) & 0xfffffff0) === 0x184d2a50) {
      const size = buf.readUInt32LE(offset + 4)
      offset += 8 + size
    } else {
      throw new Error('corrupt Zstandard session log: unknown frame')
    }
  }
  if (!chunks.length) throw new Error('empty Zstandard session log')
  return Buffer.concat(chunks).toString('utf8')
}

function zstdFrameLength(buf: Buffer, offset: number): number {
  let p = offset + 4
  if (p >= buf.length) throw new Error('corrupt Zstandard session log: truncated frame header')
  const descriptor = buf[p++]!
  if ((descriptor & 0x08) !== 0) throw new Error('corrupt Zstandard session log: reserved frame bit')
  const fcsFlag = descriptor >>> 6
  const singleSegment = (descriptor >>> 5) & 1
  const checksum = (descriptor >>> 2) & 1
  const dictFlag = descriptor & 3
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][dictFlag] ?? 0
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  p += fcsSize
  while (true) {
    if (p + 3 > buf.length) throw new Error('corrupt Zstandard session log: truncated block header')
    const header = buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16)
    p += 3
    const last = header & 1
    const type = (header >>> 1) & 3
    const size = header >>> 3
    if (type === 0) p += size
    else if (type === 1) p += 1
    else if (type === 2) p += size
    else throw new Error('corrupt Zstandard session log: reserved block type')
    if (last) break
  }
  if (checksum) p += 4
  if (p > buf.length) throw new Error('corrupt Zstandard session log: truncated frame')
  return p - offset
}

/**
 * dsh rejects a zstd log unless its first frame holds exactly the header line, so the
 * header and the remaining events go into two separate checksummed frames.
 */
export function encodeDshLog(text: string, compressed: boolean): Buffer {
  if (!compressed) return Buffer.from(text, 'utf8')
  const lines = text.split(/\r?\n/).filter((line) => line !== '')
  const header = lines.shift()
  if (header === undefined) throw new Error('dsh log has no header line')
  const params = { [constants.ZSTD_c_checksumFlag]: 1 }
  const frames = [zstdCompressSync(Buffer.from(header + '\n', 'utf8'), { params })]
  if (lines.length) frames.push(zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), { params }))
  return Buffer.concat(frames)
}
