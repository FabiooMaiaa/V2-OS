/**
 * Verificação da máquina de estados do processamento (Fase 2, Passo 3b-1).
 *
 * Prova as RPCs de claim/reserve/confirm/fail contra o banco REMOTO.
 * CUSTO ZERO DE API EXTERNA: nada aqui chama o Claude nem a Evolution.
 *
 * Uso:  node scripts/verify-processamento.mjs   (ou: npm run verify:processamento)
 * Sai com código 1 se qualquer teste falhar (serve em CI).
 *
 * O QUE PROTEGE DINHEIRO E REPUTAÇÃO AQUI:
 *   - claim simultâneo com UM só vencedor: sem isso, dois processos respondem a
 *     mesma mensagem e o CLIENTE DO ESCRITÓRIO recebe a resposta duplicada;
 *   - claim por conversa: duas mensagens seguidas viram UMA resposta, não duas
 *     (metade do custo de Claude e resposta coerente);
 *   - reserva única: o UNIQUE barra a segunda outbound do mesmo lote;
 *   - estacionamento: lote de envio ambíguo NUNCA volta à fila.
 *
 * SEGREDOS: nada hardcoded. Lê do .env.local (gitignored); nenhum valor é
 * impresso — nem chave, nem telefone, nem conteúdo de mensagem (A09).
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

for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) {
    console.error(`Falta ${k} em .env.local`)
    process.exit(1)
  }
}

const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

// Telefones exclusivos deste teste: a limpeza apaga as CONVERSAS destes números,
// e o cascade da FK remove as mensagens. Cirúrgico, sem varrer tabela.
const TELEFONES = [
  '5511900000101', // testes 1-3 (claim, expirado, esgotamento)
  '5511900000102', // testes 4-6 (lote, reserva, ciclo completo)
  '5511900000103', // teste 7 (estacionamento)
  '5511900000104', // teste 7b (requeue)
]

let falhou = false
function check(nome, ok, detalhe = '') {
  if (!ok) falhou = true
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${nome}${detalhe ? ' — ' + detalhe : ''}`)
}

/** Cria uma conversa de teste e devolve seu id. */
async function criarConversa(tenantId, telefone) {
  const { data, error } = await db
    .from('conversas')
    .insert({ tenant_id: tenantId, contato_telefone: telefone, contato_nome: 'Teste' })
    .select('id')
    .single()
  if (error) throw new Error('criarConversa: ' + error.message)
  return data.id
}

/** Insere uma inbound pendente (processed_at nulo) e devolve seu id. */
async function criarInbound(tenantId, conversaId, sufixo, conteudo) {
  const { data, error } = await db
    .from('mensagens')
    .insert({
      tenant_id: tenantId,
      conversa_id: conversaId,
      direcao: 'inbound',
      conteudo,
      external_message_id: `verify-proc-${sufixo}`,
    })
    .select('id')
    .single()
  if (error) throw new Error('criarInbound: ' + error.message)
  return data.id
}

const claim = (id) => db.rpc('claim_conversation_messages', { p_mensagem_id: id })

async function lerMensagem(id) {
  const { data } = await db
    .from('mensagens')
    .select('id, direcao, status, attempts, processed_at, processing_started_at, last_error, provider_message_id, conteudo')
    .eq('id', id)
    .single()
  return data
}

/**
 * Apaga as conversas de teste (o cascade da FK remove as mensagens) e confirma
 * que nada sobrou.
 *
 * Roda DUAS vezes de propósito. Na SAÍDA, para não deixar resíduo. E na ENTRADA,
 * porque uma execução interrompida antes do finally deixa conversa órfã, e a
 * próxima execução morre no insert com "duplicate key ... conversas_tenant_id_
 * contato_telefone_key" — erro que aponta para longe da causa real e parece
 * regressão da RPC. Com limpeza na entrada o script é idempotente e essa falha
 * enganosa não acontece.
 */
async function limparResiduo(rotulo) {
  console.log(`\n=== Limpeza (${rotulo}) ===`)
  const { data: apagadas } = await db
    .from('conversas')
    .delete()
    .in('contato_telefone', TELEFONES)
    .select('id')

  const { count: sobraramConv } = await db
    .from('conversas')
    .select('id', { count: 'exact', head: true })
    .in('contato_telefone', TELEFONES)
  const { count: sobraramMsg } = await db
    .from('mensagens')
    .select('id', { count: 'exact', head: true })
    .like('external_message_id', 'verify-proc-%')

  console.log(`conversas de teste apagadas: ${apagadas?.length ?? 0}`)
  console.log(`sobraram: ${sobraramConv} conversas / ${sobraramMsg} mensagens (esperado 0 / 0)`)
  if (sobraramConv !== 0 || sobraramMsg !== 0) falhou = true
}

// order by created_at: LIMIT 1 sem ORDER BY devolve linha ARBITRÁRIA. Com um
// tenant só está dormente, mas no dia que houver dois o teste passaria a escolher
// tenant aleatório entre execuções e os resultados ficariam irreprodutíveis.
const { data: tenant } = await db
  .from('tenants')
  .select('id')
  .order('created_at')
  .limit(1)
  .single()
const { data: agente } = await db
  .from('agentes')
  .select('system_prompt')
  .eq('tenant_id', tenant.id)
  .single()
// Destino do envio cadastrado para este tenant (Passo 3b-2). maybeSingle e não
// single: tenant sem instância é estado possível, e o teste 1g precisa poder
// distinguir "a RPC devolveu errado" de "não há instância cadastrada".
const { data: instancia } = await db
  .from('instancias_whatsapp')
  .select('instance_name')
  .eq('tenant_id', tenant.id)
  .maybeSingle()

console.log('=== Pre-condicao ===')
console.log('tenant de teste localizado, agente com prompt de', agente.system_prompt.length, 'chars')
console.log('instancia cadastrada para o tenant:', instancia ? 'sim' : 'NAO — 1g vai falhar')

// Não começa a testar sem estado limpo: um resíduo faria os testes falharem por
// motivo enganoso, e um teste que falha pela razão errada é pior que nenhum.
await limparResiduo('entrada')
if (falhou) {
  console.log('\n>>> ABORTADO: nao foi possivel chegar a um estado limpo')
  process.exit(1)
}

try {
  // ============================================================
  // 1) CLAIM SIMULTÂNEO — a prova central.
  // ============================================================
  const conversaA = await criarConversa(tenant.id, TELEFONES[0])
  const msg1 = await criarInbound(tenant.id, conversaA, 'a1', 'Bom dia, tudo bem?')

  // Duas chamadas DE VERDADE em paralelo: conexões e transações distintas.
  const [r1, r2] = await Promise.all([claim(msg1), claim(msg1)])
  const statuses = [r1.data?.status, r2.data?.status].sort()
  const vencedores = statuses.filter((s) => s === 'claimed').length

  console.log('=== TESTE 1: claim simultaneo ===')
  console.log('resultados:', statuses.join(' + '))
  check('1. exatamente UM vencedor', vencedores === 1, `${vencedores} vencedor(es)`)
  check(
    '1b. o perdedor recebeu not_claimed',
    statuses.filter((s) => s === 'not_claimed').length === 1,
  )

  const vencedor = r1.data?.status === 'claimed' ? r1.data : r2.data
  check(
    '1c. o vencedor trouxe o system_prompt do tenant',
    vencedor?.system_prompt === agente.system_prompt,
  )
  // 1g/1h cobrem o Passo 3b-2: sem estes dois campos a Edge Function sabe O QUE
  // responder mas não PARA ONDE enviar. Comparo com o que está no banco em vez de
  // só checar "não é nulo" — um join errado que trouxesse a instância de OUTRO
  // tenant passaria no teste de nulidade e enviaria a resposta de um escritório
  // para o cliente de outro (A01). Nenhum dos dois valores é impresso (A09).
  check(
    '1g. instance_name devolvido bate com o cadastrado no banco',
    vencedor?.instance_name != null && vencedor.instance_name === instancia?.instance_name,
  )
  check(
    '1h. contato_telefone devolvido bate com a conversa',
    vencedor?.contato_telefone === TELEFONES[0],
  )
  check(
    '1d. historico inclui a mensagem nova',
    Array.isArray(vencedor?.historico) &&
      vencedor.historico.length === 1 &&
      vencedor.historico[0].direcao === 'inbound',
    `itens=${vencedor?.historico?.length}`,
  )

  const depois1 = await lerMensagem(msg1)
  check('1e. attempts incrementado no claim', depois1.attempts === 1, `attempts=${depois1.attempts}`)
  check('1f. processing_started_at carimbado', depois1.processing_started_at !== null)

  // ============================================================
  // 2) CLAIM EXPIRADO — recupera órfã de processo morto.
  // ============================================================
  console.log('\n=== TESTE 2: claim expirado (orfa) ===')
  // Antes de expirar: um novo claim deve ser NEGADO (ainda está fresco).
  const aindaFresco = await claim(msg1)
  check(
    '2. claim fresco continua negado',
    aindaFresco.data?.status === 'not_claimed',
    aindaFresco.data?.status,
  )

  // Simula processo morto: carimbo de 6 minutos atrás (teto é 5).
  const seisMinAtras = new Date(Date.now() - 6 * 60 * 1000).toISOString()
  await db.from('mensagens').update({ processing_started_at: seisMinAtras }).eq('id', msg1)

  const recuperado = await claim(msg1)
  const depois2 = await lerMensagem(msg1)
  check(
    '2b. claim recupera apos 5 min',
    recuperado.data?.status === 'claimed',
    recuperado.data?.status,
  )
  check('2c. attempts subiu para 2', depois2.attempts === 2, `attempts=${depois2.attempts}`)

  // ============================================================
  // 3) ESGOTAMENTO DE TENTATIVAS.
  // ============================================================
  console.log('\n=== TESTE 3: esgotamento de tentativas ===')
  await db
    .from('mensagens')
    .update({ attempts: 5, processing_started_at: null })
    .eq('id', msg1)

  const esgotado = await claim(msg1)
  check(
    '3. attempts no teto -> not_claimed',
    esgotado.data?.status === 'not_claimed',
    esgotado.data?.status,
  )
  // E continua negado mesmo com o claim livre (processing_started_at nulo):
  // prova que é o teto barrando, não o carimbo.
  const esgotado2 = await claim(msg1)
  check('3b. permanece negado (nao volta a fila)', esgotado2.data?.status === 'not_claimed')

  // ============================================================
  // 4) CLAIM POR CONVERSA — duas mensagens, UM lote.
  // ============================================================
  console.log('\n=== TESTE 4: claim por conversa (lote) ===')
  const conversaB = await criarConversa(tenant.id, TELEFONES[1])
  const msgB1 = await criarInbound(tenant.id, conversaB, 'b1', 'Bom dia')
  const msgB2 = await criarInbound(tenant.id, conversaB, 'b2', 'preciso da guia do Simples')

  // Dispara pelo id da PRIMEIRA: o claim deve varrer a conversa e pegar as duas.
  const lote = await claim(msgB1)
  const ids = lote.data?.mensagem_ids ?? []

  check('4. lote reivindicado', lote.data?.status === 'claimed', lote.data?.status)
  check('4b. trouxe as DUAS mensagens', ids.length === 2, `ids=${ids.length}`)
  check(
    '4c. reply_key derivada da ULTIMA inbound',
    lote.data?.reply_key === `reply:${msgB2}`,
    lote.data?.reply_key,
  )
  check(
    '4d. historico com as duas, em ordem cronologica',
    lote.data?.historico?.length === 2 &&
      lote.data.historico[0].conteudo === 'Bom dia' &&
      lote.data.historico[1].conteudo === 'preciso da guia do Simples',
  )

  // ============================================================
  // 5) RESERVA ÚNICA — o UNIQUE barra a segunda outbound.
  // ============================================================
  console.log('\n=== TESTE 5: reserva unica ===')
  const RESPOSTA = 'Bom dia! Vou verificar com a equipe e retorno.'
  const reservar = () =>
    db.rpc('reserve_reply', {
      p_mensagem_ids: ids,
      p_conteudo: RESPOSTA,
      p_reply_key: lote.data.reply_key,
    })

  const [s1, s2] = await Promise.all([reservar(), reservar()])
  const reservaStatuses = [s1.data?.status, s2.data?.status].sort()

  console.log('resultados:', reservaStatuses.join(' + '))
  check(
    '5. uma reserved + uma already_sending',
    reservaStatuses.join('+') === 'already_sending+reserved',
    reservaStatuses.join('+'),
  )

  const { count: qtdOutbound } = await db
    .from('mensagens')
    .select('id', { count: 'exact', head: true })
    .eq('external_message_id', lote.data.reply_key)
  check('5b. existe UMA so linha outbound', qtdOutbound === 1, `linhas=${qtdOutbound}`)

  const outboundId = (s1.data?.outbound_id ?? s2.data?.outbound_id)
  const outbound = await lerMensagem(outboundId)
  check('5c. outbound nasce em status sending', outbound.status === 'sending', outbound.status)
  check('5d. outbound ainda nao processada', outbound.processed_at === null)

  // Resposta vazia deve ser recusada (fail-closed).
  const vazia = await db.rpc('reserve_reply', {
    p_mensagem_ids: ids,
    p_conteudo: '   ',
    p_reply_key: 'reply:teste-vazio',
  })
  check('5e. resposta vazia recusada', Boolean(vazia.error), vazia.error?.message ?? 'NAO recusou')

  // ============================================================
  // 6) CICLO COMPLETO — confirm fecha tudo numa transação.
  // ============================================================
  console.log('\n=== TESTE 6: ciclo completo (confirm) ===')
  const { data: convAntes } = await db
    .from('conversas')
    .select('ultima_mensagem_at')
    .eq('id', conversaB)
    .single()

  const confirmado = await db.rpc('confirm_reply', {
    p_outbound_id: outboundId,
    p_mensagem_ids: ids,
    p_provider_message_id: 'EVO-ID-TESTE-123',
  })

  const outFinal = await lerMensagem(outboundId)
  const in1 = await lerMensagem(msgB1)
  const in2 = await lerMensagem(msgB2)
  const { data: convDepois } = await db
    .from('conversas')
    .select('ultima_mensagem_at')
    .eq('id', conversaB)
    .single()

  check('6. confirm reportou sucesso', confirmado.data?.status === 'confirmed')
  check('6b. as DUAS inbound marcadas', confirmado.data?.inbound_marcadas === 2, `n=${confirmado.data?.inbound_marcadas}`)
  check('6c. outbound status sent', outFinal.status === 'sent', outFinal.status)
  check('6d. provider_message_id guardado', outFinal.provider_message_id === 'EVO-ID-TESTE-123')
  check('6e. processed_at nas duas inbound', in1.processed_at !== null && in2.processed_at !== null)
  check(
    '6f. ultima_mensagem_at avancou',
    new Date(convDepois.ultima_mensagem_at) > new Date(convAntes.ultima_mensagem_at ?? 0),
  )
  // Lote já respondido não pode ser reivindicado de novo.
  const jaFeito = await claim(msgB1)
  check('6g. lote respondido nao volta a fila', jaFeito.data?.status === 'not_claimed')

  // ============================================================
  // 7) ESTACIONAMENTO — envio ambíguo nunca reenvia.
  // ============================================================
  console.log('\n=== TESTE 7: falha nao-retryable (estaciona) ===')
  const conversaC = await criarConversa(tenant.id, TELEFONES[2])
  const msgC = await criarInbound(tenant.id, conversaC, 'c1', 'Preciso de ajuda')
  await claim(msgC)

  const parked = await db.rpc('fail_inbound_messages', {
    p_mensagem_ids: [msgC],
    p_error: 'EvolutionTimeout: envio ambiguo',
    p_retryable: false,
  })
  const depoisPark = await lerMensagem(msgC)

  check('7. fail reportou parked', parked.data?.status === 'parked', parked.data?.status)
  check('7b. attempts queimado ate o teto', depoisPark.attempts === 5, `attempts=${depoisPark.attempts}`)
  check('7c. claim liberado mas...', depoisPark.processing_started_at === null)
  check('7d. last_error registrado', (depoisPark.last_error ?? '').includes('EvolutionTimeout'))

  const naoVolta = await claim(msgC)
  check(
    '7e. NUNCA volta a fila (nao reenvia ao cliente)',
    naoVolta.data?.status === 'not_claimed',
    naoVolta.data?.status,
  )

  // ---------- 7b) falha retryable devolve à fila ----------
  console.log('\n=== TESTE 7b: falha retryable (devolve a fila) ===')
  const conversaD = await criarConversa(tenant.id, TELEFONES[3])
  const msgD = await criarInbound(tenant.id, conversaD, 'd1', 'Oi')
  await claim(msgD)

  const requeued = await db.rpc('fail_inbound_messages', {
    p_mensagem_ids: [msgD],
    p_error: 'AnthropicOverloaded: 529',
    p_retryable: true,
  })
  const depoisRequeue = await lerMensagem(msgD)
  const retomado = await claim(msgD)

  check('7f. fail reportou requeued', requeued.data?.status === 'requeued', requeued.data?.status)
  check('7g. attempts NAO queimado', depoisRequeue.attempts === 1, `attempts=${depoisRequeue.attempts}`)
  check('7h. claim retoma imediatamente', retomado.data?.status === 'claimed', retomado.data?.status)
} finally {
  // Roda mesmo se algo estourar acima — é o que impede resíduo de vazar para a
  // próxima execução.
  await limparResiduo('saida')
}

console.log('\n' + (falhou ? '>>> HOUVE FALHA' : '>>> TODOS PASSARAM'))
process.exit(falhou ? 1 : 0)
