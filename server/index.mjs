// FastNotebook 后端：接收 .ipynb 上传、管理 notebook 目录、按需拉起 JupyterLab
// 生产模式（FASTNOTEBOOK_HOST=0.0.0.0）：同进程托管 dist/ 静态文件，对外服务 0.0.0.0:7100
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NOTEBOOKS_DIR = path.join(ROOT, 'notebooks')
const STATE_DIR = path.join(ROOT, '.fastnotebook')
const TOKEN_FILE = path.join(STATE_DIR, 'token')
const VENV_PYTHON = path.join(ROOT, '.venv', 'bin', 'python')
const STATIC_DIR = path.join(ROOT, 'dist')
const HOST = process.env.FASTNOTEBOOK_HOST || '127.0.0.1'
const API_PORT = Number(process.env.FASTNOTEBOOK_API_PORT || 8891)
const PUBLIC = HOST !== '127.0.0.1' && HOST !== 'localhost'
const JUPYTER_PORT_START = 8866
const JUPYTER_PORT_END = 8876
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

fs.mkdirSync(NOTEBOOKS_DIR, { recursive: true })
fs.mkdirSync(STATE_DIR, { recursive: true })

// ---------- token（持久化，保证重启后旧链接仍可用） ----------
function loadOrCreateToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (t) return t
  } catch {}
  const t = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 })
  return t
}
const TOKEN = loadOrCreateToken()

// ---------- JupyterLab 进程管理 ----------
const jupyter = { proc: null, port: null, starting: null }

// 生成面向访问者的 JupyterLab 链接：主机部分与用户访问本平台时用的域名/IP 保持一致
function jupyterUrl(reqHost, p = '') {
  return `http://${reqHost}:${jupyter.port}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`
}

function requestHost(req) {
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || ''
  const host = String(hostHeader).split(':')[0].trim()
  return host || '127.0.0.1'
}

async function isOurJupyter(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api?token=${TOKEN}`, {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = http.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function waitReady(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isOurJupyter(port)) return true
    await new Promise((r) => setTimeout(r, 800))
  }
  return false
}

async function adoptExisting() {
  for (let p = JUPYTER_PORT_START; p <= JUPYTER_PORT_END; p++) {
    if (await isOurJupyter(p)) {
      jupyter.port = p
      return p
    }
  }
  return null
}

async function ensureJupyter() {
  // 已在本进程拉起且端口仍健康
  if (jupyter.proc && jupyter.port && !jupyter.proc.killed) {
    if (await isOurJupyter(jupyter.port)) return jupyter.port
  }
  // 已有之前遗留的实例可直接复用
  const adopted = await adoptExisting()
  if (adopted) return adopted
  if (jupyter.starting) return jupyter.starting

  jupyter.starting = (async () => {
    if (!fs.existsSync(VENV_PYTHON)) {
      throw new Error('未找到项目 Python 环境（.venv），请先运行: python3 -m venv .venv && .venv/bin/pip install jupyterlab')
    }
    let port = null
    for (let p = JUPYTER_PORT_START; p <= JUPYTER_PORT_END; p++) {
      if (await isPortFree(p)) { port = p; break }
    }
    if (!port) throw new Error(`端口 ${JUPYTER_PORT_START}-${JUPYTER_PORT_END} 均被占用`)

    const args = [
      '-m', 'jupyterlab',
      '--no-browser',
      `--ServerApp.ip=${PUBLIC ? '0.0.0.0' : '127.0.0.1'}`,
      `--ServerApp.port=${port}`,
      `--ServerApp.root_dir=${NOTEBOOKS_DIR}`,
      `--IdentityProvider.token=${TOKEN}`,
      '--ServerApp.disable_check_xsrf=true',
    ]
    const logFd = fs.openSync(path.join(STATE_DIR, 'jupyter.log'), 'a')
    const proc = spawn(VENV_PYTHON, args, { cwd: NOTEBOOKS_DIR, stdio: ['ignore', logFd, logFd] })
    proc.on('exit', (code) => {
      try { fs.closeSync(logFd) } catch {}
      if (jupyter.proc === proc) { jupyter.proc = null; jupyter.port = null }
      console.log(`[fastnotebook] jupyter-lab exited, code=${code}`)
    })
    jupyter.proc = proc
    jupyter.port = port
    const ok = await waitReady(port)
    if (!ok) {
      try { proc.kill('SIGTERM') } catch {}
      jupyter.proc = null
      jupyter.port = null
      throw new Error('JupyterLab 启动超时，请查看 .fastnotebook/jupyter.log')
    }
    console.log(`[fastnotebook] jupyter-lab ready at port ${port}`)
    return port
  })()

  try {
    return await jupyter.starting
  } finally {
    jupyter.starting = null
  }
}

// ---------- notebook 文件 ----------
function sanitizeName(name) {
  let base = path.basename(String(name || '')).trim()
  base = base.replace(/[^\w.\-()（）一-鿿 ]/g, '_')
  if (!base.toLowerCase().endsWith('.ipynb')) base += '.ipynb'
  if (base.length > 120) base = base.slice(-120)
  return base
}

function listNotebooks() {
  return fs.readdirSync(NOTEBOOKS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.ipynb') && !f.startsWith('.'))
    .map((f) => {
      const st = fs.statSync(path.join(NOTEBOOKS_DIR, f))
      return { name: f, size: st.size, mtime: st.mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

function validateNotebook(text) {
  let nb
  try { nb = JSON.parse(text) } catch { throw new Error('文件不是合法的 JSON，无法作为 notebook') }
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells) || typeof nb.nbformat !== 'number') {
    throw new Error('文件缺少 nbformat/cells 字段，不是有效的 .ipynb notebook')
  }
  return nb
}

// ---------- 静态文件（生产模式托管 dist/） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(path.join(STATIC_DIR, 'index.html'))) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('前端尚未构建，请先运行 npm run build')
  }
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const filePath = path.normalize(path.join(STATIC_DIR, rel))
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); return res.end('forbidden')
  }
  let target = filePath
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // SPA 回退
    target = path.join(STATIC_DIR, 'index.html')
  }
  const ext = path.extname(target).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  if (ext === '.html') {
    // OG 标签需要绝对地址：按用户实际访问的域名/IP 动态注入，保持全局一致
    const origin = `http://${req.headers.host || '127.0.0.1'}`
    const html = fs.readFileSync(target, 'utf8').replaceAll('%PUBLIC_ORIGIN%', origin)
    return res.end(html)
  }
  fs.createReadStream(target).pipe(res)
}

// ---------- HTTP 服务 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('文件过大（超过 64MB）')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const route = `${req.method} ${url.pathname}`
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {})

    if (route === 'GET /api/status') {
      if (!jupyter.port) await adoptExisting()
      const running = jupyter.port ? await isOurJupyter(jupyter.port) : false
      if (!running) jupyter.port = null
      return sendJson(res, 200, {
        jupyter: { running, port: running ? jupyter.port : null },
        notebooks: listNotebooks().length,
        pythonReady: fs.existsSync(VENV_PYTHON),
      })
    }

    if (route === 'GET /api/notebooks') {
      return sendJson(res, 200, { notebooks: listNotebooks() })
    }

    if (route === 'POST /api/upload') {
      const name = sanitizeName(url.searchParams.get('name'))
      if (!name || name === '.ipynb') return sendJson(res, 400, { error: '缺少文件名' })
      const body = await readBody(req, MAX_UPLOAD_BYTES)
      const text = body.toString('utf8')
      validateNotebook(text)
      const target = path.join(NOTEBOOKS_DIR, name)
      const overwritten = fs.existsSync(target)
      fs.writeFileSync(target, text)
      return sendJson(res, 200, { name, overwritten, size: body.length })
    }

    if (route === 'POST /api/open') {
      const body = await readBody(req, 1024 * 1024)
      const { name } = JSON.parse(body.toString('utf8') || '{}')
      const safe = sanitizeName(name)
      if (!fs.existsSync(path.join(NOTEBOOKS_DIR, safe))) {
        return sendJson(res, 404, { error: `找不到 notebook: ${safe}` })
      }
      await ensureJupyter()
      return sendJson(res, 200, { url: jupyterUrl(requestHost(req), `/lab/tree/${encodeURIComponent(safe)}`) })
    }

    if (route === 'POST /api/jupyter/start') {
      await ensureJupyter()
      return sendJson(res, 200, { url: jupyterUrl(requestHost(req), '/lab') })
    }

    if (route === 'DELETE /api/notebooks') {
      const safe = sanitizeName(url.searchParams.get('name'))
      const target = path.join(NOTEBOOKS_DIR, safe)
      if (!fs.existsSync(target)) return sendJson(res, 404, { error: '文件不存在' })
      fs.unlinkSync(target)
      return sendJson(res, 200, { deleted: safe })
    }

    // 非 /api 请求 → 静态托管（生产模式）
    if (!url.pathname.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveStatic(req, res, url.pathname)
    }

    return sendJson(res, 404, { error: 'unknown route' })
  } catch (err) {
    console.error(`[fastnotebook] ${route} failed:`, err)
    return sendJson(res, 500, { error: err?.message || String(err) })
  }
})

server.listen(API_PORT, HOST, () => {
  console.log(`[fastnotebook] listening on http://${HOST}:${API_PORT} (public=${PUBLIC})`)
})

process.on('SIGTERM', () => { try { jupyter.proc?.kill('SIGTERM') } catch {}; process.exit(0) })
process.on('SIGINT', () => { try { jupyter.proc?.kill('SIGTERM') } catch {}; process.exit(0) })
