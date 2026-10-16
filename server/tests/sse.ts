// Leitor de SSE dos testes, sem depender do app em processo (serve também para servidores de verdade).
import assert from 'node:assert/strict'

export interface SseMessage {
  event: string
  data: string
}

/** Leitor de SSE: guarda as mensagens recebidas e permite esperar pela próxima de um tipo. */
export class Sse {
  messages: SseMessage[] = []
  private cursor = 0
  private waiters = new Set<() => void>()
  private reader: ReadableStreamDefaultReader<Uint8Array>
  response: Response
  closed = false

  constructor(response: Response) {
    this.response = response
    this.reader = response.body!.getReader()
    void this.pump()
  }

  private async pump() {
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await this.reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
          const data = [...block.matchAll(/^data: (.*)$/gm)].map((m) => m[1]).join('\n')
          if (block.startsWith(':')) continue
          this.messages.push({ event, data })
          this.waiters.forEach((w) => w())
        }
      }
    } catch {
      // leitura cancelada
    } finally {
      this.closed = true
      this.waiters.forEach((w) => w())
    }
  }

  /**
   * Próxima mensagem do tipo `event` (a partir da última consumida) que satisfaz `where`.
   * Falha se não chegar em `timeout` ms.
   */
  async next<T = any>(event: string, opts: { timeout?: number; where?: (data: T) => boolean } = {}): Promise<T> {
    const { timeout = 2000, where } = opts
    const deadline = Date.now() + timeout
    for (;;) {
      for (; this.cursor < this.messages.length; this.cursor++) {
        const m = this.messages[this.cursor]!
        if (m.event !== event) continue
        const data = m.data ? JSON.parse(m.data) : null
        if (!where || where(data)) {
          this.cursor++
          return data as T
        }
      }
      if (this.closed) throw new Error(`stream fechado antes de "${event}"`)
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`"${event}" não chegou em ${timeout} ms`)
      await new Promise<void>((resolve) => {
        const done = () => {
          this.waiters.delete(done)
          clearTimeout(t)
          resolve()
        }
        const t = setTimeout(done, left)
        this.waiters.add(done)
      })
    }
  }

  /** Garante que nenhuma mensagem `event` satisfazendo `where` chegue em `ms`. */
  async none(event: string, ms = 300, where?: (data: any) => boolean) {
    await assert.rejects(this.next(event, { timeout: ms, where }), /não chegou/)
  }

  close() {
    void this.reader.cancel().catch(() => {})
  }
}
