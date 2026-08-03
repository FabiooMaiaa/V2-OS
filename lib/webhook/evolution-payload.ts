// Parsing e sanitização do payload da Evolution API.
//
// Esta é a PRIMEIRA entrada não confiável do sistema (A05). Fica em módulo
// próprio, separado do route handler, por dois motivos: o handler cuida de
// HTTP/autenticação e este arquivo cuida de dado hostil; e uma função pura é
// testável sem subir servidor nem rede.
//
// Regra geral: extrair o MÍNIMO necessário (LGPD — minimização) e descartar tudo
// que não seja mensagem de texto de um contato individual.

/** Teto do conteúdo gravado. Protege storage e custo de token por chamada. */
export const MAX_CONTENT_CHARS = 4000

/** Teto do pushName. É nome de exibição escolhido pelo contato — dado hostil. */
const MAX_NOME_CHARS = 100

export type ParsedInbound =
  | {
      ok: true
      instanceName: string
      externalMessageId: string
      contatoTelefone: string
      contatoNome: string | null
      conteudo: string
    }
  | { ok: false; reason: string; instanceName: string | null }

const descartar = (reason: string, instanceName: string | null = null) =>
  ({ ok: false, reason, instanceName }) as ParsedInbound

/**
 * Placeholder textual por tipo de mídia. NENHUMA mídia binária é persistida —
 * decisão registrada no schema do Passo 1: um anexo vira só referência textual,
 * o que reduz drasticamente a superfície de dado sensível (LGPD) e o custo.
 */
const PLACEHOLDER_POR_TIPO: Record<string, string> = {
  audioMessage: '[áudio recebido]',
  imageMessage: '[imagem recebida]',
  videoMessage: '[vídeo recebido]',
  documentMessage: '[documento recebido]',
  stickerMessage: '[figurinha recebida]',
  locationMessage: '[localização recebida]',
  contactMessage: '[contato recebido]',
  contactsArrayMessage: '[contatos recebidos]',
}

const CODIGO_TAB = 9
const CODIGO_LF = 10
const CODIGO_DEL = 127

/** Só aceita string não vazia dentro de um tamanho plausível. */
function texto(valor: unknown, maxLen: number): string | null {
  if (typeof valor !== 'string') return null
  const t = valor.trim()
  if (!t || t.length > maxLen) return null
  return t
}

/**
 * Remove caracteres de controle, preservando tab e quebra de linha.
 *
 * O BYTE NULO é o caso crítico: o tipo `text` do Postgres o REJEITA, então um
 * cliente derrubaria o insert só mandando um. Os demais controles saem porque
 * poluem o prompt sem significar nada.
 *
 * Filtra por CÓDIGO em vez de regex de propósito: uma classe de caracteres com
 * escapes de controle é frágil (some numa cópia, quebra num editor) e ilegível.
 */
function limpar(valor: string): string {
  let saida = ''
  for (const ch of valor) {
    const codigo = ch.codePointAt(0) ?? 0
    const ehControle =
      codigo === CODIGO_DEL ||
      (codigo < 32 && codigo !== CODIGO_LF && codigo !== CODIGO_TAB)
    if (!ehControle) saida += ch
  }
  return saida
}

/**
 * Normaliza o nome do evento. A Evolution manda 'messages.upsert' ou
 * 'MESSAGES_UPSERT' dependendo da configuração (webhook por evento); tratar as
 * duas formas evita um webhook silenciosamente ignorado por causa de maiúscula.
 */
function normalizarEvento(evento: unknown): string | null {
  if (typeof evento !== 'string') return null
  return evento.toLowerCase().replace(/_/g, '.')
}

export function parseInboundMessage(payload: unknown): ParsedInbound {
  if (typeof payload !== 'object' || payload === null) {
    return descartar('payload nao e objeto')
  }
  const p = payload as Record<string, unknown>

  const instanceName = texto(p.instance, 100)
  if (!instanceName) return descartar('instance ausente ou invalida')

  if (normalizarEvento(p.event) !== 'messages.upsert') {
    return descartar('evento nao tratado', instanceName)
  }

  // A Evolution manda `data` como objeto; algumas versões usam array. Aceita as
  // duas formas em vez de descartar por diferença de formato.
  const bruto = Array.isArray(p.data) ? p.data[0] : p.data
  if (typeof bruto !== 'object' || bruto === null) {
    return descartar('data ausente', instanceName)
  }
  const data = bruto as Record<string, unknown>
  const key = data.key as Record<string, unknown> | undefined
  if (typeof key !== 'object' || key === null) {
    return descartar('key ausente', instanceName)
  }

  // DESCARTE MAIS IMPORTANTE DO ARQUIVO: as nossas próprias mensagens voltam
  // como evento. Processá-las faria o agente responder a si mesmo EM LOOP,
  // gastando API do Claude a cada volta. É o bug mais caro possível aqui.
  if (key.fromMe === true) {
    return descartar('mensagem propria (fromMe)', instanceName)
  }

  const remoteJid = texto(key.remoteJid, 100)
  if (!remoteJid) return descartar('remoteJid ausente', instanceName)

  // Grupo: fora do escopo do MVP e risco de privacidade (mensagens de terceiros
  // num grupo não deveriam ser processadas nem gravadas).
  if (remoteJid.endsWith('@g.us')) {
    return descartar('mensagem de grupo', instanceName)
  }
  if (remoteJid.startsWith('status@')) {
    return descartar('status broadcast', instanceName)
  }

  // Sem id externo não existe idempotência (NULL não conflita com NULL no índice
  // único), e sem idempotência a reentrega cobraria o Claude de novo. Descarta.
  const externalMessageId = texto(key.id, 200)
  if (!externalMessageId) {
    return descartar('sem external_message_id', instanceName)
  }

  // Telefone: só os dígitos antes do @. Faixa 8-20 cobre número nacional e
  // internacional sem aceitar lixo.
  const contatoTelefone = remoteJid.split('@')[0].replace(/\D/g, '')
  if (contatoTelefone.length < 8 || contatoTelefone.length > 20) {
    return descartar('telefone implausivel', instanceName)
  }

  const conteudo = extrairConteudo(data.message)
  if (!conteudo) return descartar('sem conteudo aproveitavel', instanceName)

  const nomeBruto = texto(data.pushName, MAX_NOME_CHARS)
  const contatoNome = nomeBruto ? limpar(nomeBruto).trim() || null : null

  return {
    ok: true,
    instanceName,
    externalMessageId,
    contatoTelefone,
    contatoNome,
    conteudo,
  }
}

/**
 * Texto da mensagem, ou placeholder se for mídia. Devolve null quando não há
 * nada aproveitável — aí a mensagem é descartada em vez de gravar linha vazia.
 */
function extrairConteudo(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>

  // Texto simples e texto com citação/preview são os dois formatos comuns. O
  // teto de leitura é maior que o de gravação: aceita a mensagem longa e trunca
  // depois, em vez de descartá-la por tamanho.
  const direto = texto(m.conversation, MAX_CONTENT_CHARS * 4)
  const estendido = texto(
    (m.extendedTextMessage as Record<string, unknown> | undefined)?.text,
    MAX_CONTENT_CHARS * 4,
  )
  const bruto = direto ?? estendido

  if (bruto) {
    // Trunca DEPOIS de limpar: limpar pode encurtar, e o teto vale para o que
    // realmente será gravado.
    const limpo = limpar(bruto).trim()
    return limpo ? limpo.slice(0, MAX_CONTENT_CHARS) : null
  }

  // Mídia: guarda só a referência textual.
  for (const [tipo, placeholder] of Object.entries(PLACEHOLDER_POR_TIPO)) {
    if (m[tipo]) return placeholder
  }

  // Tipo desconhecido (reação, enquete, chamada...). Grava uma marca genérica em
  // vez de descartar: o agente precisa saber que ALGO chegou, senão responderia
  // como se o cliente tivesse ficado calado.
  return '[mensagem não suportada]'
}
