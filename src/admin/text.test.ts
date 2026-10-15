import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditText, detailPairs, device } from './text.ts'

test('device: navegador e sistema em palavras', () => {
  const cases: [string, string][] = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome no macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari no iPhone'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge no Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0', 'Firefox no Linux'],
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'Chrome no Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1', 'Chrome no iPhone'],
    ['curl/8.7.1', 'Aparelho desconhecido'],
    ['', 'Aparelho desconhecido'],
  ]
  for (const [ua, expected] of cases) assert.equal(device(ua), expected, ua)
})

test('auditoria: frase por ação, com o papel novo e sem JSON cru', () => {
  assert.equal(auditText({ action: 'admin.role_changed', detail: { role: 'admin' } }), 'Papel alterado para Administração geral')
  assert.equal(auditText({ action: 'admin.role_changed', detail: {} }), 'Papel alterado')
  assert.equal(auditText({ action: 'auth.login', detail: {} }), 'Entrou no console')
  // Ação de um servidor mais novo: aparece como veio, sem quebrar a página.
  assert.equal(auditText({ action: 'auth.passkey_added' as never, detail: {} }), 'auth.passkey_added')
  assert.deepEqual(detailPairs({ action: 'admin.role_changed', detail: { role: 'admin', from: 'moderator' } }), [['Antes', 'Moderação']])
  assert.deepEqual(detailPairs({ action: 'admin.settings_changed', detail: { requireMfaForModerators: true, sessionIdleHours: 8 } }), [
    ['Duas etapas na moderação', 'sim'],
    ['Sessão sem uso (horas)', '8'],
  ])
})
