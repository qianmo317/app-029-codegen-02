// Node harness：patch fetch/localStorage 后直接执行浏览器验收 runAcceptance 的全部断言
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

globalThis.fetch = (async (url: unknown) => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const u = String((url as Request)?.url ?? url).replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '')
  const buf = await readFile(path.resolve(__dirname, '..', 'public', u))
  return {
    ok: true,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  } as Response
}) as typeof fetch

class LocalStorageShim {
  private m = new Map<string, string>()
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string): void { this.m.set(k, v) }
  removeItem(k: string): void { this.m.delete(k) }
  clear(): void { this.m.clear() }
}
;(globalThis as Record<string, unknown>).localStorage = new LocalStorageShim()
;(globalThis as Record<string, unknown>).performance = globalThis.performance

import { runAcceptance } from '../src/logic/selftest'
import { defaultPreset } from '../src/logic/materials'

void (await mkdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.tmp'), { recursive: true }).catch(() => {}))
void writeFile

const report = await runAcceptance(defaultPreset)
for (const c of report.checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.id} ${c.title} —— ${c.detail}`)
  if (!c.pass) for (const e of c.evidence) console.log('    ', e)
}
console.log(`\n${report.allPass ? 'ALL PASS' : 'SOME FAILED'} (${report.elapsedMs.toFixed(0)}ms, ${report.checks.length} 项)`)
process.exit(report.allPass ? 0 : 1)
