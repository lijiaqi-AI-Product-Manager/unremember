#!/usr/bin/env node
// Keep the zstd APIs out of the module graph until after the version check:
// Node < 22.19 fails a static `node:zlib` named import before any user code runs.
const parts = process.versions.node.split('.').map(Number)
const major = parts[0] ?? 0
const minor = parts[1] ?? 0
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`unremember 需要 Node.js >= 22.19（当前 ${process.versions.node}）。请升级 Node 后重试。`)
  process.exit(1)
}
await import('./cli.js')
