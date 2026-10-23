import { describe, expect, it } from 'vitest'
import { zstdDecompressSync } from 'node:zlib'
import { JsonlFile, decodeDshLog, encodeDshLog } from '../src/fsx.js'

describe('JsonlFile', () => {
  it('writes untouched lines back byte for byte', () => {
    const text = '{"a": 1,  "b":2}\r\n{"type":"user","x":"secret"}\r\n{"c":3}\r\n'
    const f = new JsonlFile(text)
    expect(f.toString()).toBe(text)
    const e = f.get(1)
    e.x = ''
    f.set(1, e)
    f.remove(2)
    expect(f.toString()).toBe('{"a": 1,  "b":2}\r\n{"type":"user","x":""}\r\n')
  })

  it('tolerates a torn last line', () => {
    const f = new JsonlFile('{"a":1}\n{"b":')
    expect(f.get(0)).toEqual({ a: 1 })
    expect(f.get(1)).toBeUndefined()
  })
})

describe('encodeDshLog', () => {
  const text = '{"type":"session","version":4,"id":"s1"}\n{"type":"user/message","seq":0}\n{"type":"turn/end","seq":1}\n'

  it('puts the header alone in the first zstd frame', () => {
    const buf = encodeDshLog(text, true)
    expect(decodeDshLog(buf)).toBe(text)
    // Frame 1 is a complete zstd frame holding only the header line.
    const second = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4)
    expect(second).toBeGreaterThan(0)
    expect(zstdDecompressSync(buf.subarray(0, second)).toString('utf8')).toBe('{"type":"session","version":4,"id":"s1"}\n')
  })

  it('leaves plain logs alone', () => {
    expect(encodeDshLog(text, false).toString('utf8')).toBe(text)
  })
})
