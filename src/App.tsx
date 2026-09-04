import { useCallback, useEffect, useRef, useState } from 'react'
import {
  UploadCloud, FileText, Trash2, ExternalLink,
  Loader2, Play, CircleCheck, CircleOff,
} from 'lucide-react'
import { Toaster, toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

type NotebookItem = { name: string; size: number; mtime: number }
type Status = {
  jupyter: { running: boolean; port: number | null }
  notebooks: number
  pythonReady: boolean
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [notebooks, setNotebooks] = useState<NotebookItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [startingLab, setStartingLab] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, n] = await Promise.all([
        fetch('/api/status').then((r) => r.json()),
        fetch('/api/notebooks').then((r) => r.json()),
      ])
      setStatus(s)
      setNotebooks(n.notebooks ?? [])
    } catch {
      // 后端尚未就绪，静默等待下一轮轮询
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.ipynb'))
    if (list.length === 0) {
      toast.error('请选择 .ipynb 文件')
      return
    }
    setUploading(true)
    for (const file of list) {
      try {
        const text = await file.text()
        const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: text,
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || '上传失败')
        toast.success(`已上传 ${data.name}${data.overwritten ? '（已覆盖同名文件）' : ''}`)
      } catch (err) {
        toast.error(`${file.name}：${err instanceof Error ? err.message : '上传失败'}`)
      }
    }
    setUploading(false)
    refresh()
  }

  async function openInLab(name: string) {
    setOpening(name)
    try {
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '打开失败')
      window.open(data.url, '_blank')
      toast.success(`已在 JupyterLab 中打开 ${name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打开失败')
    } finally {
      setOpening(null)
      refresh()
    }
  }

  async function openLabHome() {
    setStartingLab(true)
    try {
      const res = await fetch('/api/jupyter/start', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '启动失败')
      window.open(data.url, '_blank')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'JupyterLab 启动失败')
    } finally {
      setStartingLab(false)
      refresh()
    }
  }

  async function removeNotebook(name: string) {
    try {
      const res = await fetch(`/api/notebooks?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '删除失败')
      toast.success(`已删除 ${name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
    refresh()
  }

  const labRunning = status?.jupyter.running ?? false

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <Toaster richColors position="top-center" />
      <div className="mx-auto max-w-2xl px-6 py-10">
        {/* Header */}
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="./logo.svg" alt="FastNotebook logo" className="h-10 w-10 drop-shadow-sm" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                <span className="bg-gradient-to-br from-orange-400 to-orange-600 bg-clip-text text-transparent">Fast</span>Notebook
              </h1>
              <p className="text-xs text-neutral-500">上传 .ipynb，一键在 JupyterLab 中运行</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {labRunning ? (
              <Badge variant="secondary" className="gap-1.5 bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                <CircleCheck className="h-3.5 w-3.5" />
                JupyterLab 运行中 :{status?.jupyter.port}
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1.5 bg-neutral-200 text-neutral-500 hover:bg-neutral-200">
                <CircleOff className="h-3.5 w-3.5" />
                JupyterLab 未启动
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={openLabHome} disabled={startingLab}>
              {startingLab ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {labRunning ? '打开 JupyterLab' : '启动 JupyterLab'}
            </Button>
          </div>
        </header>

        {/* Drop zone */}
        <Card
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed py-12 transition-colors',
            dragOver ? 'border-orange-400 bg-orange-50' : 'border-neutral-300 bg-white hover:border-neutral-400',
          )}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            uploadFiles(e.dataTransfer.files)
          }}
        >
          {uploading ? (
            <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
          ) : (
            <UploadCloud className={cn('h-8 w-8', dragOver ? 'text-orange-500' : 'text-neutral-400')} />
          )}
          <p className="text-sm font-medium">
            {uploading ? '正在上传…' : '拖拽 .ipynb 文件到这里，或点击选择'}
          </p>
          <p className="text-xs text-neutral-400">支持一次选择多个 notebook，上传后即可直接运行</p>
          <input
            ref={fileInput}
            type="file"
            accept=".ipynb"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) uploadFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </Card>

        {/* Notebook list */}
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-600">
              我的 Notebooks{notebooks.length > 0 ? `（${notebooks.length}）` : ''}
            </h2>
          </div>

          {notebooks.length === 0 ? (
            <p className="rounded-lg border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-400">
              还没有 notebook，先上传一个吧
            </p>
          ) : (
            <ul className="space-y-2">
              {notebooks.map((nb) => (
                <li
                  key={nb.name}
                  className="group flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3"
                >
                  <FileText className="h-4 w-4 shrink-0 text-orange-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{nb.name}</p>
                    <p className="text-xs text-neutral-400">
                      {formatSize(nb.size)} · {formatTime(nb.mtime)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="bg-orange-500 text-white hover:bg-orange-600"
                    onClick={() => openInLab(nb.name)}
                    disabled={opening === nb.name}
                  >
                    {opening === nb.name ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    打开运行
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
                    onClick={() => removeNotebook(nb.name)}
                    title="删除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="mt-10 text-center text-xs text-neutral-400">
          上传的文件保存在项目 notebooks/ 目录，JupyterLab 按需自动启动
        </footer>
      </div>
    </div>
  )
}
