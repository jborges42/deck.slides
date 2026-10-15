export class ApiError extends Error {
  status: number
  /** Código para o cliente reagir (ex.: 'sudo_required' abre a confirmação de senha). Ver shared/admin.ts. */
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T = { ok: true }>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique a rede.', 0)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? 'Não foi possível concluir. Tente novamente.', res.status, data.code)
  return data as T
}

export const post = <T = { ok: true }>(path: string, body: unknown = {}) => api<T>(path, 'POST', body)
export const patch = <T = { ok: true }>(path: string, body: unknown) => api<T>(path, 'PATCH', body)
export const del = <T = { ok: true }>(path: string) => api<T>(path, 'DELETE')

/** Envia um arquivo como corpo bruto. XHR porque fetch não informa progresso de envio. */
export function upload<T>(path: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api${path}`)
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name))
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onload = () => {
      const data = (() => {
        try {
          return JSON.parse(xhr.responseText)
        } catch {
          return {}
        }
      })()
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T)
      else reject(new ApiError(data.error ?? 'Falha no envio do arquivo.', xhr.status))
    }
    xhr.onerror = () => reject(new ApiError('Sem conexão com o servidor. Verifique a rede.', 0))
    xhr.send(file)
  })
}
