/**
 * Verificação do webhook da Evolution (Fase 2, Passo 3a).
 *
 * Bate no endpoint REAL rodando localmente e confere o efeito no banco REMOTO.
 * Custo zero de API externa: o Passo 3a não chama o Claude.
 *
 * Uso:
 *   1) em outro terminal: npm run dev
 *   2) npm run verify:webhook
 *
 * Sai com código 1 se qualquer cenário falhar (serve em CI).
 *
 * OS DOIS TESTES QUE PROTEGEM DINHEIRO:
 *   - idempotência: reentrega da mesma mensagem NÃO cria segunda linha (e, no
 *     Passo 3b, não vai chamar o Claude de novo);
 *   - fromMe: a nossa própria mensagem é descartada. Sem isso o agente responde
 *     a si mesmo em LOOP, gastando API a cada volta.
 *
 * SEGREDOS: nada hardcoded. Tudo vem do .env.local (gitignored) e nenhum valor é
 * impresso — nem o segredo, nem telefone, nem conteúdo de mensagem.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local')
const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1).trim()]
    }),
)

for (const k of [
  'EVOLUTION_WEBHOOK_SECRET',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]) {
  if (!env[k]) {
    console.error(`Falta ${k} em .env.local`)
    process.exit(1)
  }
}

const SECRET = env.EVOLUTION_WEBHOOK_SECRET
const BASE = env.WEBHOOK_BASE_URL ?? 'http://localhost:3000'
const URL_WEBHOOK = `${BASE}/api/webhooks/evolution`
// Precisa existir em instancias_whatsapp apontando para um tenant real.
const INSTANCIA = env.TEST_INSTANCE_NAME ?? 'teste-local'

// Prefixo em TODO id/telefone de teste: permite limpeza cirúrgica no fim, sem
// varrer a tabela e sem risco de apagar dado que não é nosso.
const PREFIXO = 'verify-webhook'
const TELEFONE = '5511900000001'
const TELEFONE_GRUPO = '5511900000002'

const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

let falhou = false
function check(nome, ok, detalhe = '') {
  if (!ok) falhou = true
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${nome}${detalhe ? ' — ' + detalhe : ''}`)
}

/** Monta um payload messages.upsert no formato da Evolution. */
function payload({
  instance = INSTANCIA,
  id,
  jid = `${TELEFONE}@s.whatsapp.net`,
  fromMe = false,
  text = 'Bom dia, preciso da guia do Simples.',
  pushName = 'Cliente Teste',
  event = 'messages.upsert',
  message,
} = {}) {
  return {
    event,
    instance,
    data: {
      key: { id, remoteJid: jid, fromMe },
      pushName,
      message: message ?? { conversation: text },
    },
  }
}

/**
 * POST no webhook. `token`: undefined = segredo correto; null = OMITE o header;
 * string = usa aquele valor.
 */
async function post(corpo, token) {
  const headers = { 'content-type': 'application/json' }
  if (token !== null) headers['x-webhook-token'] = token ?? SECRET

  let res
  try {
    res = await fetch(URL_WEBHOOK, {
      method: 'POST',
      headers,
      body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
    })
  } catch (e) {
    console.error(
      `\nNAO CONSEGUI FALAR COM ${URL_WEBHOOK}\n` +
        'O servidor esta rodando? Suba com: npm run dev\n' +
        `(erro: ${e.message})`,
    )
    process.exit(1)
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    // 401 responde corpo vazio de propósito — json fica null.
  }
  return { status: res.status, json }
}

/** Conta mensagens por external_message_id (via service_role, ignora RLS). */
async function contarMensagens(externalId) {
  const { count } = await db
    .from('mensagens')
    .select('id', { count: 'exact', head: true })
    .eq('external_message_id', externalId)
  return count ?? 0
}

async function buscarMensagem(externalId) {
  const { data } = await db
    .from('mensagens')
    .select('id, tenant_id, conversa_id, direcao, conteudo, processed_at')
    .eq('external_message_id', externalId)
    .maybeSingle()
  return data
}

// ============================================================
// Pré-condição: a instância de teste tem que existir, senão TUDO cai em
// unknown_instance e o resultado não significaria nada.
// ============================================================
const { data: instancia } = await db
  .from('instancias_whatsapp')
  .select('tenant_id, instance_name')
  .eq('instance_name', INSTANCIA)
  .maybeSingle()

console.log('=== Pre-condicao ===')
if (!instancia) {
  console.error(
    `Instancia "${INSTANCIA}" nao existe em instancias_whatsapp.\n` +
      'Crie no SQL Editor:\n' +
      `  insert into instancias_whatsapp (tenant_id, instance_name)\n` +
      `  select id, '${INSTANCIA}' from tenants order by created_at limit 1\n` +
      `  on conflict (instance_name) do nothing;`,
  )
  process.exit(1)
}
console.log(`instancia "${INSTANCIA}" mapeada a um tenant: OK`)
console.log(`endpoint: ${URL_WEBHOOK}\n`)

try {
  // ============================================================
  // 1-2) ORIGEM — o cadeado da porta.
  // ============================================================
  console.log('=== Origem (401) ===')
  const semHeader = await post(payload({ id: `${PREFIXO}-nao-usado-1` }), null)
  check(
    '1. sem header X-Webhook-Token -> 401',
    semHeader.status === 401,
    `status ${semHeader.status}`,
  )
  check('1b. corpo vazio no 401', semHeader.json === null)

  const tokenErrado = await post(
    payload({ id: `${PREFIXO}-nao-usado-2` }),
    'segredo-errado-mas-do-mesmo-tamanho-aproximado',
  )
  check(
    '2. header com segredo errado -> 401',
    tokenErrado.status === 401,
    `status ${tokenErrado.status}`,
  )

  // Prova que os 401 acima NÃO gravaram nada.
  check(
    '2b. nenhuma gravacao a partir de request nao autenticada',
    (await contarMensagens(`${PREFIXO}-nao-usado-1`)) === 0 &&
      (await contarMensagens(`${PREFIXO}-nao-usado-2`)) === 0,
  )

  // ============================================================
  // 3) INSTÂNCIA DESCONHECIDA — fail-closed, mas 200 (erro permanente).
  // ============================================================
  console.log('\n=== Resolucao de tenant ===')
  const desconhecida = await post(
    payload({ id: `${PREFIXO}-instancia-x`, instance: 'instancia-que-nao-existe' }),
  )
  check(
    '3. instancia desconhecida -> 200 ignorado',
    desconhecida.status === 200 && desconhecida.json?.ignored === 'instancia desconhecida',
    JSON.stringify(desconhecida.json),
  )
  check(
    '3b. nada gravado para instancia desconhecida',
    (await contarMensagens(`${PREFIXO}-instancia-x`)) === 0,
  )

  // ============================================================
  // 4) CAMINHO FELIZ.
  // ============================================================
  console.log('\n=== Caminho feliz ===')
  const idTexto = `${PREFIXO}-texto-1`
  const inserida = await post(payload({ id: idTexto }))
  check(
    '4. mensagem de texto -> 200 inserted',
    inserida.status === 200 && inserida.json?.status === 'inserted',
    JSON.stringify(inserida.json),
  )

  const msg = await buscarMensagem(idTexto)
  check('4b. linha existe em mensagens', Boolean(msg))
  check('4c. direcao = inbound', msg?.direcao === 'inbound')
  check(
    '4d. tenant_id veio da instancia (nao do payload)',
    msg?.tenant_id === instancia.tenant_id,
  )
  check(
    '4e. processed_at NULL (gravada, ainda nao respondida)',
    msg?.processed_at === null,
  )

  const { data: conversa } = await db
    .from('conversas')
    .select('id, contato_nome, ultima_mensagem_at')
    .eq('contato_telefone', TELEFONE)
    .maybeSingle()
  check('4f. conversa criada para o contato', Boolean(conversa))
  check(
    '4g. ultima_mensagem_at carimbada na mensagem nova',
    Boolean(conversa?.ultima_mensagem_at),
  )

  // ============================================================
  // 5) IDEMPOTÊNCIA — protege dinheiro.
  // ============================================================
  console.log('\n=== Idempotencia ===')
  const carimboAntes = conversa?.ultima_mensagem_at
  const repetida = await post(payload({ id: idTexto }))
  check(
    '5. reentrega do mesmo id -> 200 duplicate',
    repetida.status === 200 && repetida.json?.status === 'duplicate',
    JSON.stringify(repetida.json),
  )
  check(
    '5b. NAO criou segunda linha (o UNIQUE barrou)',
    (await contarMensagens(idTexto)) === 1,
  )

  // Detalhe fino: duplicata não deve reordenar a lista de conversas.
  const { data: conversaDepois } = await db
    .from('conversas')
    .select('ultima_mensagem_at')
    .eq('contato_telefone', TELEFONE)
    .maybeSingle()
  check(
    '5c. duplicata NAO mexeu em ultima_mensagem_at',
    conversaDepois?.ultima_mensagem_at === carimboAntes,
    `antes=${carimboAntes} depois=${conversaDepois?.ultima_mensagem_at}`,
  )

  // ============================================================
  // 6) fromMe — o anti-loop. Protege dinheiro.
  // ============================================================
  console.log('\n=== Descartes ===')
  const idProprio = `${PREFIXO}-frommee-1`
  const propria = await post(payload({ id: idProprio, fromMe: true }))
  check(
    '6. fromMe:true -> 200 ignorado (anti-loop)',
    propria.status === 200 && propria.json?.ignored === 'mensagem propria (fromMe)',
    JSON.stringify(propria.json),
  )
  check('6b. nada gravado para fromMe', (await contarMensagens(idProprio)) === 0)

  // 7) grupo
  const idGrupo = `${PREFIXO}-grupo-1`
  const grupo = await post(
    payload({ id: idGrupo, jid: `${TELEFONE_GRUPO}-1600000000@g.us` }),
  )
  check(
    '7. mensagem de grupo -> 200 ignorado',
    grupo.status === 200 && grupo.json?.ignored === 'mensagem de grupo',
    JSON.stringify(grupo.json),
  )
  check('7b. nada gravado para grupo', (await contarMensagens(idGrupo)) === 0)

  // 8) sem key.id -> sem idempotência possível
  const semId = await post(payload({ id: undefined }))
  check(
    '8. sem key.id -> 200 ignorado',
    semId.status === 200 && semId.json?.ignored === 'sem external_message_id',
    JSON.stringify(semId.json),
  )

  // 9) JSON malformado
  const malformado = await post('{ isto nao e json valido')
  check(
    '9. json malformado -> 200 ignorado',
    malformado.status === 200 && malformado.json?.ignored === 'json invalido',
    JSON.stringify(malformado.json),
  )

  // 10) status broadcast
  const idBroadcast = `${PREFIXO}-broadcast-1`
  const broadcast = await post(
    payload({ id: idBroadcast, jid: 'status@broadcast' }),
  )
  check(
    '10. status@broadcast -> 200 ignorado',
    broadcast.status === 200 && broadcast.json?.ignored === 'status broadcast',
    JSON.stringify(broadcast.json),
  )

  // 11) evento não tratado
  const idEvento = `${PREFIXO}-evento-1`
  const outroEvento = await post(
    payload({ id: idEvento, event: 'connection.update' }),
  )
  check(
    '11. evento nao tratado -> 200 ignorado',
    outroEvento.status === 200 && outroEvento.json?.ignored === 'evento nao tratado',
    JSON.stringify(outroEvento.json),
  )

  // 11b) MAIÚSCULA_COM_UNDERSCORE deve ser aceito (normalização do evento)
  const idUpper = `${PREFIXO}-upper-1`
  const eventoUpper = await post(
    payload({ id: idUpper, event: 'MESSAGES_UPSERT' }),
  )
  check(
    '11b. evento MESSAGES_UPSERT normalizado e aceito',
    eventoUpper.status === 200 && eventoUpper.json?.status === 'inserted',
    JSON.stringify(eventoUpper.json),
  )

  // ============================================================
  // 12-13) SANITIZAÇÃO E MÍDIA.
  // ============================================================
  console.log('\n=== Sanitizacao e midia ===')
  const idAudio = `${PREFIXO}-audio-1`
  const audio = await post(
    payload({ id: idAudio, message: { audioMessage: { seconds: 3 } } }),
  )
  const msgAudio = await buscarMensagem(idAudio)
  check(
    '12. audio -> inserted com placeholder textual',
    audio.json?.status === 'inserted' && msgAudio?.conteudo === '[áudio recebido]',
    `conteudo=${JSON.stringify(msgAudio?.conteudo)}`,
  )

  // Byte nulo: o tipo `text` do Postgres o REJEITA. Sem a limpeza, este insert
  // derrubaria a RPC. String.fromCharCode(0) evita escape literal no arquivo.
  const idNulo = `${PREFIXO}-nulo-1`
  const textoComNulo = `antes${String.fromCharCode(0)}depois`
  const comNulo = await post(payload({ id: idNulo, text: textoComNulo }))
  const msgNulo = await buscarMensagem(idNulo)
  check(
    '13. byte nulo -> inserted, byte removido',
    comNulo.json?.status === 'inserted' &&
      msgNulo?.conteudo === 'antesdepois',
    `conteudo=${JSON.stringify(msgNulo?.conteudo)}`,
  )

  // Truncagem: texto acima do teto entra cortado, não rejeitado.
  const idLongo = `${PREFIXO}-longo-1`
  await post(payload({ id: idLongo, text: 'a'.repeat(5000) }))
  const msgLongo = await buscarMensagem(idLongo)
  check(
    '14. texto acima do teto -> truncado em 4000',
    msgLongo?.conteudo?.length === 4000,
    `tamanho=${msgLongo?.conteudo?.length}`,
  )
} finally {
  // ============================================================
  // LIMPEZA — cirúrgica pelo prefixo, para não tocar dado que não é do teste.
  // Roda mesmo se algum cenário estourar.
  // ============================================================
  console.log('\n=== Limpeza ===')
  const { data: apagadas } = await db
    .from('mensagens')
    .delete()
    .like('external_message_id', `${PREFIXO}-%`)
    .select('id')
  await db
    .from('conversas')
    .delete()
    .in('contato_telefone', [TELEFONE, TELEFONE_GRUPO])

  const { count: sobraram } = await db
    .from('mensagens')
    .select('id', { count: 'exact', head: true })
    .like('external_message_id', `${PREFIXO}-%`)

  console.log(`mensagens de teste apagadas: ${apagadas?.length ?? 0}`)
  console.log(`sobraram: ${sobraram} (esperado 0)`)
  if (sobraram !== 0) falhou = true
}

console.log('\n' + (falhou ? '>>> HOUVE FALHA' : '>>> TODOS PASSARAM'))
process.exit(falhou ? 1 : 0)
