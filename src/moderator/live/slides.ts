// Apresentação do palestrante -> imagens dos slides, no navegador do console. O telão só mostra imagens:
// abre igual em qualquer computador, sem fontes nem programa do palestrante. O pdf.js carrega só aqui.
// PowerPoint, Keynote, Google Slides e Canva exportam PDF; animações e vídeos dentro dos slides não vêm junto.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { uploadMedia } from '../MediaPicker.tsx'

/** Cada página cabe em 1920 × 1080 (projetor Full HD). */
const BOX = { w: 1920, h: 1080 }

export const SLIDE_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,image/avif'

// "Slide2.png" antes de "Slide10.png" (exportação de imagens do PowerPoint e do Keynote)
const byName = new Intl.Collator('pt-BR', { numeric: true }).compare
const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)

async function pdfjs() {
  const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  lib.GlobalWorkerOptions.workerSrc = worker.default
  return lib
}

async function render(page: PDFPageProxy): Promise<Blob> {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: Math.min(BOX.w / base.width, BOX.h / base.height) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  await page.render({ canvas, viewport }).promise
  page.cleanup()
  // WebP pequeno e nítido; navegador sem codificador WebP devolve PNG (o servidor aceita os dois).
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('canvas vazio'))), 'image/webp', 0.9))
}

/**
 * Converte e envia os slides (PDFs viram uma imagem por página; imagens vão como estão, em ordem de nome).
 * Devolve os endereços na ordem, ou null se algo falhou (o erro já foi avisado).
 * ponytail: um slide por vez; se importar ficar lento na Vercel, enviar 3 em paralelo.
 */
export async function importSlides(eventId: string, files: File[], onProgress: (done: number, total: number) => void): Promise<string[] | null> {
  const sorted = [...files].sort((a, b) => byName(a.name, b.name))
  const lib = sorted.some(isPdf) ? await pdfjs() : null
  const docs = new Map<File, PDFDocumentProxy>()
  try {
    for (const f of sorted.filter(isPdf)) docs.set(f, await lib!.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise)
  } catch {
    for (const d of docs.values()) void d.loadingTask.destroy()
    throw new Error('Não foi possível abrir o PDF. Exporte a apresentação de novo em PDF e tente outra vez.')
  }
  const total = sorted.reduce((n, f) => n + (docs.get(f)?.numPages ?? 1), 0)
  const urls: string[] = []
  const send = async (blob: Blob, name: string) => {
    const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : (name.split('.').pop() ?? 'png')
    const m = await uploadMedia(eventId, blob instanceof File ? blob : new File([blob], `${name}.${ext}`, { type: blob.type }))
    if (m) urls.push(m.url)
    onProgress(urls.length, total)
    return !!m
  }
  try {
    onProgress(0, total)
    for (const f of sorted) {
      const doc = docs.get(f)
      if (!doc) {
        if (!(await send(f, f.name))) return null
        continue
      }
      const base = f.name.replace(/\.pdf$/i, '')
      for (let n = 1; n <= doc.numPages; n++) {
        const blob = await render(await doc.getPage(n))
        if (!(await send(blob, `${base} - slide ${String(n).padStart(2, '0')}`))) return null
      }
    }
    return urls
  } finally {
    for (const d of docs.values()) void d.loadingTask.destroy()
  }
}
