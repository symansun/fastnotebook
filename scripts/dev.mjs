// 同时启动 FastNotebook 后端与 Vite 开发服务器
// `npm run dev -- --port 7100 --host 0.0.0.0` 的参数会原样转发给 vite
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = path.join(ROOT, 'node_modules', '.bin', 'vite')
const forwardArgs = process.argv.slice(2)

const backend = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
})
const vite = spawn(viteBin, forwardArgs, { cwd: ROOT, stdio: 'inherit' })

function shutdown(code = 0) {
  for (const p of [vite, backend]) {
    try { p.kill('SIGTERM') } catch {}
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
backend.on('exit', (code) => { if (code) console.error(`[dev] backend exited with ${code}`) })
vite.on('exit', (code) => shutdown(code ?? 0))
