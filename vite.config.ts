import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn, type ChildProcess } from 'node:child_process'

const API_PORT = process.env.API_PORT ?? '3000'

// Em desenvolvimento, `vite` também sobe a API com `node --watch` (reinicia ao salvar).
function api(): Plugin {
  return {
    name: 'deck-api',
    apply: 'serve',
    configureServer() {
      const g = globalThis as { deckApi?: ChildProcess }
      if (g.deckApi) return // o Vite reavalia a config ao reiniciar; mantém um processo só
      g.deckApi = spawn(process.execPath, ['--watch', 'server/index.ts'], {
        stdio: 'inherit',
        env: { ...process.env, PORT: API_PORT },
      })
      process.on('exit', () => g.deckApi?.kill())
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), api()],
  server: {
    // O servidor de desenvolvimento só entrega o que o navegador precisa: nada de banco, código do servidor ou configuração.
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/data/**', '*.db', '*.db-*', '**/server/**', '*.md', 'package.json', 'pnpm-*.yaml', 'tsconfig.json'],
    },
    proxy: {
      // Quando a API reinicia (node --watch), o proxy deixaria os SSE abertos pendurados para sempre:
      // fechar a resposta faz o navegador perceber a queda na hora e reconectar.
      '/api': {
        target: `http://localhost:${API_PORT}`,
        configure: (proxy) =>
          proxy.on('proxyRes', (proxyRes, _req, res) => proxyRes.on('close', () => !res.writableEnded && res.destroy())),
      },
      '/media': `http://localhost:${API_PORT}`,
    },
  },
})
