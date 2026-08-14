-- Fase 2 (Passo 3b-2, pré-requisito) — o claim passa a devolver também PARA ONDE
-- a resposta vai.
--
-- POR QUE: o 3b-1 devolvia com o que responder (system_prompt, historico) mas não
-- para onde — faltavam o telefone do contato e o instance_name da Evolution. Sem
-- os dois a Edge Function não tem como enviar.
--
-- POR QUE NO BANCO E NÃO NO TYPESCRIPT: o mesmo argumento do 3b-1. A Edge Function
-- escreve com service_role, que IGNORA o RLS; então quem garante que o telefone e
-- a instância pertencem ao MESMO TENANT da mensagem é este SQL, não a aplicação.
-- Buscar os dois no TypeScript custaria duas idas extras à rede por mensagem e
-- moveria a derivação de destino para fora da única camada que não pode errar.
-- Enviar a resposta de um escritório para o cliente de outro é a pior falha
-- possível deste sistema (A01).
--
-- MUDANÇA ESTRITAMENTE ADITIVA: nenhuma chave existente do jsonb muda de nome,
-- tipo ou valor, e a assinatura da função é a mesma. As 35 asserções do
-- verify:processamento seguem válidas — inclusive a 1c, que compara o
-- system_prompt devolvido e portanto cobre justamente o SELECT reescrito abaixo.

create or replace function public.claim_conversation_messages(
  p_mensagem_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversa_id uuid;
  v_tenant_id   uuid;
  v_ids         uuid[];
  v_prompt      text;
  v_instance    text;
  v_telefone    text;
  v_historico   jsonb;
  -- Idade a partir da qual um claim é considerado abandonado (processo morto).
  c_stale       constant interval := interval '5 minutes';
  -- Tetos da janela de histórico: o que vier primeiro. 20 mensagens dá contexto
  -- suficiente para atendimento; o teto de caracteres impede que 20 mensagens
  -- longas estourem o custo de token por chamada.
  c_max_msgs    constant int := 20;
  c_max_chars   constant int := 8000;
begin
  select m.conversa_id, m.tenant_id
    into v_conversa_id, v_tenant_id
  from public.mensagens m
  where m.id = p_mensagem_id;

  if v_conversa_id is null then
    return jsonb_build_object('status', 'not_claimed', 'reason', 'mensagem inexistente');
  end if;

  -- O CLAIM. Pega TODAS as inbound pendentes da conversa, não só a que disparou.
  with reivindicadas as (
    update public.mensagens m
    set processing_started_at = now(),
        attempts              = m.attempts + 1
    where m.conversa_id = v_conversa_id
      and m.direcao = 'inbound'
      and m.processed_at is null
      and (m.processing_started_at is null or m.processing_started_at < now() - c_stale)
      and m.attempts < public.inbound_max_attempts()
    returning m.id, m.created_at
  )
  select array_agg(r.id order by r.created_at)
    into v_ids
  from reivindicadas r;

  if v_ids is null or array_length(v_ids, 1) is null then
    -- Ou outro caller ganhou a corrida, ou tudo já foi processado, ou as
    -- tentativas esgotaram. Nos três casos: não processa.
    return jsonb_build_object('status', 'not_claimed', 'reason', 'nada reivindicavel');
  end if;

  -- ============================================================
  -- O QUE RESPONDER + PARA ONDE ENVIAR, numa consulta só.
  --
  -- LEFT JOIN e não INNER, de propósito: com INNER, uma instância não cadastrada
  -- faria a consulta não devolver linha nenhuma e o system_prompt viria NULL
  -- junto — transformando "falta a instância" em "falta o prompt" e escondendo a
  -- causa real. Com LEFT JOIN cada ausência aparece como NULL no seu próprio
  -- campo, e a Edge Function estaciona o lote com o diagnóstico correto ANTES de
  -- gastar chamada de API.
  --
  -- Junta por tenant_id em vez de por instance_name porque agentes.tenant_id e
  -- instancias_whatsapp.tenant_id são UNIQUE (uma instância e um agente por
  -- escritório): no máximo uma linha de cada lado, sem risco de multiplicar a
  -- conversa e escolher uma instância arbitrária.
  --
  -- NÃO devolvo instancias_whatsapp.status de propósito: essa coluna é um cache
  -- que pode estar velho, e a Edge Function consulta o estado real da instância
  -- na Evolution antes de reservar. Devolvê-la só criaria a tentação de confiar
  -- em dado defasado e recusar o envio de uma instância que está no ar.
  -- ============================================================
  select a.system_prompt, i.instance_name, c.contato_telefone
    into v_prompt, v_instance, v_telefone
  from public.conversas c
  left join public.agentes a             on a.tenant_id = c.tenant_id
  left join public.instancias_whatsapp i on i.tenant_id = c.tenant_id
  where c.id = v_conversa_id;

  -- ============================================================
  -- Janela de histórico, mais recente para trás, com ORÇAMENTO DE CARACTERES.
  --
  -- `acumulado - length(conteudo) < c_max_chars` inclui uma mensagem se o
  -- orçamento ainda não havia estourado ANTES dela. O efeito colateral desejado:
  -- a mensagem mais recente entra sempre (o acumulado menos ela mesma é 0),
  -- então nunca devolvemos histórico vazio por causa de uma mensagem longa.
  --
  -- Devolve o histórico BRUTO, em ordem cronológica, já incluindo as mensagens
  -- recém-reivindicadas no fim. Quem formata para a API do Claude (mapear
  -- direcao->role, fundir papéis consecutivos, garantir que a primeira é 'user')
  -- é a Edge Function: o SQL cuida de atomicidade e isolamento de tenant, o
  -- TypeScript cuida do formato da API.
  -- ============================================================
  with janela as (
    select m.direcao, m.conteudo, m.created_at
    from public.mensagens m
    where m.conversa_id = v_conversa_id
    order by m.created_at desc
    limit c_max_msgs
  ),
  orcada as (
    select j.*,
           sum(length(j.conteudo)) over (order by j.created_at desc) as acumulado
    from janela j
  )
  select jsonb_agg(
           jsonb_build_object('direcao', o.direcao, 'conteudo', o.conteudo)
           order by o.created_at
         )
    into v_historico
  from orcada o
  where o.acumulado - length(o.conteudo) < c_max_chars;

  return jsonb_build_object(
    'status',        'claimed',
    'tenant_id',     v_tenant_id,
    'conversa_id',   v_conversa_id,
    'system_prompt', coalesce(v_prompt, ''),
    -- Destino do envio. Ficam SEM coalesce de propósito: null aqui é informação
    -- ("instância não cadastrada"), e a Edge Function precisa distinguir isso de
    -- string vazia para estacionar com o motivo certo.
    'instance_name',    v_instance,
    'contato_telefone', v_telefone,
    'mensagem_ids',  to_jsonb(v_ids),
    -- Chave determinística da resposta: derivada da ÚLTIMA inbound do lote.
    -- É o que o UNIQUE (tenant_id, external_message_id) usa para garantir uma
    -- resposta por lote, mesmo se a função for invocada duas vezes.
    'reply_key',     'reply:' || (v_ids[array_length(v_ids, 1)])::text,
    'historico',     coalesce(v_historico, '[]'::jsonb)
  );
end;
$$;

-- ============================================================
-- LEAST-PRIVILEGE reafirmado.
--
-- `create or replace function` PRESERVA os privilégios existentes quando a
-- assinatura não muda, então estas duas linhas são tecnicamente redundantes.
-- Mantenho-as porque o custo de estar errado é assimétrico: uma função
-- SECURITY DEFINER que escreve em mensagens ignorando o RLS, exposta a anon,
-- seria falha crítica. Aqui a redundância é a defesa, não desperdício.
-- ============================================================
revoke execute on function public.claim_conversation_messages(uuid)
  from public, anon, authenticated;
grant  execute on function public.claim_conversation_messages(uuid)
  to service_role;
