import { createHash, timingSafeEqual } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseInboundMessage } from '@/lib/webhook/evolution-payload'

// Runtime NODE, não Edge: preciso de timingSafeEqual (node:crypto) e do client
// service_role. Force-dynamic porque a rota nunca pode ser cacheada.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Teto do corpo. Payload da Evolution é pequeno; acima disto é abuso ou bug. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Webhook de recepção de mensagens do WhatsApp (via Evolution API).
 *
 * ATENÇÃO — ESTE ENDPOINT É A INVERSÃO DO PASSO 2. Não há sessão, então a escrita
 * usa service_role, que IGNORA o RLS. As proteções do banco que valem aqui são as
 * que não dependem de sessão: a RPC resolve o tenant_id internamente (nunca vem
 * do payload) e a FK composta (conversa_id, tenant_id) impede cruzar tenants.
 *
 * POLÍTICA DE STATUS HTTP — a regra é: 5xx SÓ quando o retry tem chance de dar
 * certo. Tudo que é erro PERMANENTE responde 200, senão a Evolution reenviaria
 * para sempre uma mensagem que nunca será aceita.
 *
 *   401  segredo ausente/errado  -> não é a Evolution; retry é irrelevante
 *   200  instância desconhecida  -> permanente
 *   200  evento/mensagem descartada -> permanente
 *   200  payload malformado      -> permanente
 *   200  duplicata               -> já processada (idempotência)
 *   503  falha de infra          -> transitório; aqui o retry ajuda
 */
export async function POST(request: Request): Promise<Response> {
  // ============================================================
  // 1) ORIGEM — PRIMEIRA coisa, antes de ler ou parsear qualquer byte do corpo.
  // ============================================================
  if (!isFromEvolution(request)) {
    // Corpo vazio e NADA logado do payload: quem falhou aqui não é a Evolution,
    // e não vamos gravar dado de um desconhecido nos nossos logs.
    return new Response(null, { status: 401 })
  }

  // ============================================================
  // 2) TAMANHO — barra antes de materializar o corpo na memória.
  // ============================================================
  const declarado = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declarado) && declarado > MAX_BODY_BYTES) {
    return ignorado('corpo grande demais')
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return falhaTransitoria('corpo ilegivel')
  }
  // content-length pode mentir (ou faltar): confere o tamanho real também.
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return ignorado('corpo grande demais')
  }

  // ============================================================
  // 3) PARSE — JSON inválido é erro permanente, nunca exceção vazando.
  // ============================================================
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return ignorado('json invalido')
  }

  // ============================================================
  // 4) VALIDAÇÃO E SANITIZAÇÃO do dado hostil (ver lib/webhook).
  // ============================================================
  const parsed = parseInboundMessage(payload)
  if (!parsed.ok) {
    return ignorado(parsed.reason, parsed.instanceName)
  }

  // ============================================================
  // 5) GRAVAÇÃO ATÔMICA E IDEMPOTENTE.
  //
  // Note o que NÃO é passado: tenant_id. A RPC o deriva do instance_name, então
  // nem um bug daqui consegue gravar no tenant errado.
  // ============================================================
  const admin = createAdminClient()
  const { data, error } = await admin.rpc('receive_inbound_message', {
    p_instance_name: parsed.instanceName,
    p_external_message_id: parsed.externalMessageId,
    p_contato_telefone: parsed.contatoTelefone,
    p_contato_nome: parsed.contatoNome,
    p_conteudo: parsed.conteudo,
  })

  if (error) {
    // Pode ser banco fora (transitório) ou bug nosso. Nos dois casos 503: se for
    // transitório o retry resolve, e se for bug as retries falhando ficam
    // visíveis no log em vez de sumirem silenciosamente.
    console.error('webhook evolution: RPC falhou', {
      instance: parsed.instanceName,
      code: error.code,
    })
    return falhaTransitoria('rpc falhou')
  }

  const resultado = data?.[0]
  const status = resultado?.status ?? 'sem_status'

  if (status === 'unknown_instance') {
    // Recorrência disto é sinal de configuração errada — ou de alguém com o
    // segredo sondando quais instâncias existem. Nos dois casos quero ver no log.
    return ignorado('instancia desconhecida', parsed.instanceName)
  }

  if (status === 'duplicate') {
    // Reentrega da Evolution. O índice único barrou a duplicação, e é ESTE
    // caminho que impede chamar o Claude duas vezes pela mesma mensagem.
    return Response.json({ ok: true, status: 'duplicate' })
  }

  if (status !== 'inserted' || !resultado?.mensagem_id) {
    console.error('webhook evolution: status inesperado da RPC', {
      instance: parsed.instanceName,
      status,
    })
    return falhaTransitoria('status inesperado')
  }

  // Mensagem nova, gravada, com processed_at NULL. O processamento (Claude +
  // resposta) é o Passo 3b — aqui só recebemos.
  console.info('webhook evolution: mensagem recebida', {
    instance: parsed.instanceName,
    mensagemId: resultado.mensagem_id,
  })
  return Response.json({ ok: true, status: 'inserted' })
}

/**
 * Confere que o POST veio da Evolution, por SEGREDO COMPARTILHADO.
 *
 * A Evolution API NÃO assina requisições (não há HMAC do corpo como Stripe ou
 * GitHub), então não existe assinatura criptográfica a verificar: o melhor
 * disponível é um segredo combinado. Consequência a ter clara: quem tiver o
 * segredo consegue forjar mensagem — ele é o cadeado da porta, e vazamento pede
 * rotação imediata.
 *
 * Compara o SHA-256 dos dois em tempo constante. O hash serve a dois propósitos:
 * garante o mesmo tamanho (timingSafeEqual exige buffers iguais) e evita o
 * vazamento do TAMANHO do segredo que um `if (a.length !== b.length)` teria.
 */
function isFromEvolution(request: Request): boolean {
  const esperado = process.env.EVOLUTION_WEBHOOK_SECRET
  // Fail-closed: variável não configurada NEGA tudo. Nunca "sem segredo, libera".
  if (!esperado) {
    console.error('webhook evolution: EVOLUTION_WEBHOOK_SECRET nao configurado')
    return false
  }

  const recebido = request.headers.get('x-webhook-token')
  if (!recebido) return false

  const digest = (valor: string) => createHash('sha256').update(valor).digest()
  return timingSafeEqual(digest(recebido), digest(esperado))
}

/**
 * Erro PERMANENTE: responde 200 para a Evolution parar de reenviar, e registra o
 * motivo. Log sem PII (A09): instance_name e motivo, nunca telefone, nunca
 * conteúdo, nunca o nome do contato.
 */
function ignorado(reason: string, instance: string | null = null): Response {
  console.warn('webhook evolution: ignorado', { reason, instance })
  // Devolve o motivo no corpo: quem chega aqui já passou pelo segredo, e ter o
  // motivo no retorno torna o teste com curl muito mais direto.
  return Response.json({ ok: true, ignored: reason })
}

/** Erro TRANSITÓRIO: 503 para a Evolution tentar de novo. */
function falhaTransitoria(reason: string): Response {
  return Response.json({ ok: false, error: reason }, { status: 503 })
}
