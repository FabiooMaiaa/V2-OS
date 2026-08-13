-- Fase 2 (Passo 3b-1) — fundação do processamento: colunas de controle + RPCs de
-- claim/reserve/confirm/fail. NENHUMA chamada de API externa acontece aqui.
--
-- O RISCO SE INVERTE EM RELAÇÃO AO 3a. Lá o erro caro era duplicar o RECEBIMENTO
-- (cobrar o Claude 2x). Aqui é duplicar o ENVIO — mandar a mesma resposta duas
-- vezes ao cliente do escritório. Todo o desenho abaixo existe por isso.
--
-- O claim é por CONVERSA, não por mensagem: quando o cliente manda "Bom dia" e
-- "preciso da guia" em sequência, as duas são reivindicadas juntas, viram UMA
-- chamada ao Claude e UMA resposta. Sem isso seriam duas respostas, a segunda
-- sem ter visto a primeira — além de custar o dobro.

-- ============================================================
-- 1) COLUNAS DE CONTROLE.
--
-- processed_at (já existia, do Passo 3a) = respondida com sucesso.
-- As quatro abaixo cobrem os estados intermediários.
-- ============================================================
alter table public.mensagens
  -- O CLAIM. NULL = livre. Preenchido = alguém está processando agora. O
  -- processamento que morre no meio deixa isto preenchido para sempre, e é por
  -- isso que o claim trata carimbo velho (> 5 min) como abandonado e reivindica
  -- de novo — é o que recupera a mensagem órfã.
  add column processing_started_at timestamptz,

  -- Contador de tentativas. Incrementado NO CLAIM (não na falha): assim uma
  -- falha que mata o processo antes de reportar ainda é contada, e nada entra em
  -- loop infinito. Ao atingir o teto a mensagem para de ser reivindicada e fica
  -- visível para inspeção humana.
  add column attempts smallint not null default 0,

  -- Diagnóstico da última falha. TRUNCADO em 500 chars e SEM PII (A09): guarda
  -- classe/mensagem do erro, nunca conteúdo de mensagem nem telefone.
  add column last_error text,

  -- Id que a Evolution devolve ao enviar. Fica separado do external_message_id
  -- porque este último carrega a NOSSA chave determinística de idempotência
  -- ('reply:<id>'). Sem esta coluna não haveria como casar os webhooks futuros
  -- de status (delivered/read) com a linha da resposta.
  add column provider_message_id text;

-- ============================================================
-- 2) TETO DE TENTATIVAS — fonte única.
--
-- Mora numa função porque DUAS funções dependem do mesmo número: o claim rejeita
-- lotes com attempts >= teto, e fail_inbound_messages usa exatamente o teto para
-- ESTACIONAR um lote de envio ambíguo. Se os dois divergissem, um lote
-- estacionado voltaria a ser reivindicado e o cliente poderia receber a mesma
-- resposta duas vezes — falha silenciosa e cara. Com uma fonte só, não divergem.
--
-- IMMUTABLE: é constante, o planner pode inliná-la.
-- ============================================================
create or replace function public.inbound_max_attempts()
returns smallint
language sql
immutable
set search_path = ''
as $$ select 5::smallint $$;

-- ============================================================
-- 3) CLAIM POR CONVERSA.
--
-- ATOMICIDADE — por que um UPDATE guardado basta e não precisa de lock
-- explícito: em READ COMMITTED, dois callers simultâneos disputando a mesma
-- linha fazem o segundo BLOQUEAR até o primeiro commitar; aí o segundo
-- reavalia o WHERE contra a linha já atualizada, não casa mais, e afeta ZERO
-- linhas. Zero linhas afetadas é o sinal de "outro pegou" — mesma lição do
-- teste 4 do Passo 2c, onde a contagem de linhas era a única prova confiável.
--
-- O array de ids sai do RETURNING do próprio UPDATE, dentro de uma CTE. Isso
-- NÃO é estilo: se eu reconsultasse a tabela depois do update para montar o
-- array, a re-leitura veria também linhas que outra transação acabou de
-- reivindicar e commitar — e processaríamos mensagens que não são nossas,
-- gerando resposta duplicada. O RETURNING devolve só as linhas que ESTE update
-- tocou.
--
-- tenant_id e conversa_id são DERIVADOS da mensagem aqui dentro, nunca
-- parâmetros. A Edge Function escreve com service_role, que ignora o RLS —
-- manter a derivação no banco é o que impede um bug de cruzar tenants.
--
-- Devolve jsonb (e não `returns table`) porque o retorno é aninhado: além dos
-- escalares, leva o histórico como array.
-- ============================================================
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

  -- system_prompt do agente do tenant (o texto que o owner edita na tela 2b).
  select a.system_prompt into v_prompt
  from public.agentes a
  where a.tenant_id = v_tenant_id;

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
-- 4) RESERVA DA RESPOSTA — grava a outbound ANTES de enviar.
--
-- Esta é a peça que decide entre "cliente recebe resposta dupla" e "cliente
-- pode ficar sem resposta". A ordem é: reserva (status 'sending') -> envia ->
-- confirma (status 'sent'). Se o processo morrer entre reservar e confirmar,
-- a linha fica em 'sending' e NÃO sabemos se chegou ao cliente.
--
-- DECISÃO REGISTRADA: nesse caso NÃO reenviamos. Resposta duplicada para
-- cliente de escritório de contabilidade parece descontrole; falta de resposta
-- com alerta interno é recuperável. A linha fica achável por
-- `status = 'sending' and processed_at is null`.
--
-- O UNIQUE (tenant_id, external_message_id) é o árbitro: uma segunda invocação
-- recebe conflito em vez de criar uma segunda resposta. Note que o insert
-- satisfaz a FK composta (conversa_id, tenant_id) por construção, porque os dois
-- vêm da mesma linha inbound.
--
-- 'sending' é um valor NOVO em mensagens.status (o Passo 1 previa
-- sent/delivered/read/failed). Deliberadamente NÃO adiciono um CHECK agora: o
-- vocabulário de status ainda vai crescer quando os webhooks de entrega
-- entrarem, e travá-lo cedo custaria uma migration a mais sem ganho.
-- ============================================================
create or replace function public.reserve_reply(
  p_mensagem_ids uuid[],
  p_conteudo     text,
  p_reply_key    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id   uuid;
  v_conversa_id uuid;
  v_outbound_id uuid;
  v_status      text;
begin
  if p_mensagem_ids is null or array_length(p_mensagem_ids, 1) is null then
    raise exception 'mensagem_ids obrigatório';
  end if;
  if p_reply_key is null or btrim(p_reply_key) = '' then
    raise exception 'reply_key obrigatório';
  end if;
  if p_conteudo is null or btrim(p_conteudo) = '' then
    -- Resposta vazia nunca deve ser reservada nem enviada (fail-closed): melhor
    -- silêncio com alerta que mandar mensagem em branco ao cliente.
    raise exception 'conteúdo da resposta vazio';
  end if;

  -- tenant/conversa derivados das próprias inbound — nunca por parâmetro.
  select m.tenant_id, m.conversa_id
    into v_tenant_id, v_conversa_id
  from public.mensagens m
  where m.id = p_mensagem_ids[1];

  if v_tenant_id is null then
    raise exception 'mensagem inexistente';
  end if;

  insert into public.mensagens (
    tenant_id, conversa_id, direcao, conteudo, external_message_id, status
  )
  values (
    v_tenant_id, v_conversa_id, 'outbound', btrim(p_conteudo), p_reply_key, 'sending'
  )
  on conflict (tenant_id, external_message_id) do nothing
  returning id into v_outbound_id;

  if v_outbound_id is not null then
    return jsonb_build_object('status', 'reserved', 'outbound_id', v_outbound_id);
  end if;

  -- Conflito: alguém já reservou esta resposta. O status existente diz o que
  -- fazer — 'sent' significa que já foi entregue (basta finalizar), qualquer
  -- outro valor significa janela ambígua (não reenviar).
  select m.id, m.status into v_outbound_id, v_status
  from public.mensagens m
  where m.tenant_id = v_tenant_id
    and m.external_message_id = p_reply_key;

  return jsonb_build_object(
    'status',      case when v_status = 'sent' then 'already_sent' else 'already_sending' end,
    'outbound_id', v_outbound_id
  );
end;
$$;

-- ============================================================
-- 5) CONFIRMAÇÃO — fecha o ciclo numa transação só.
--
-- Marca a outbound como enviada, guarda o id da Evolution, carimba processed_at
-- nas inbound do lote e sobe a conversa na lista. Tudo junto: se qualquer parte
-- falhar, nada é commitado e a varredura reencontra o lote pendente.
-- ============================================================
create or replace function public.confirm_reply(
  p_outbound_id          uuid,
  p_mensagem_ids         uuid[],
  p_provider_message_id  text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversa_id uuid;
  v_inbound     int;
begin
  update public.mensagens m
  set status              = 'sent',
      provider_message_id = p_provider_message_id,
      processed_at        = now()
  where m.id = p_outbound_id
    and m.direcao = 'outbound'
  returning m.conversa_id into v_conversa_id;

  if v_conversa_id is null then
    raise exception 'outbound inexistente';
  end if;

  -- processed_at nas inbound = "respondida". A partir daqui a varredura de
  -- órfãs não as enxerga mais. last_error é limpo: uma tentativa anterior que
  -- falhou não deve deixar rastro de erro numa mensagem já respondida.
  update public.mensagens m
  set processed_at = now(),
      last_error   = null
  where m.id = any(p_mensagem_ids)
    and m.direcao = 'inbound';
  get diagnostics v_inbound = row_count;

  update public.conversas c
  set ultima_mensagem_at = now()
  where c.id = v_conversa_id;

  return jsonb_build_object('status', 'confirmed', 'inbound_marcadas', v_inbound);
end;
$$;

-- ============================================================
-- 6) FALHA — devolve o lote para a fila, ou o estaciona.
--
-- p_retryable distingue as duas classes de falha, e a diferença é a que evita
-- resposta duplicada:
--
--   true  -> a falha ocorreu ANTES de reservar a resposta (ex.: Claude fora do
--            ar). Nada foi enviado, então repetir é seguro: libera o claim e a
--            varredura tenta de novo. attempts já foi contado no claim.
--
--   false -> a falha ocorreu DEPOIS de reservar, com envio AMBÍGUO. Repetir
--            poderia mandar a mesma mensagem duas vezes ao cliente. Então
--            QUEIMA as tentativas restantes de propósito (attempts = teto): o
--            guard do claim passa a rejeitar o lote para sempre, e ele fica
--            visível em `attempts >= inbound_max_attempts() and processed_at is
--            null` para inspeção humana.
--
-- last_error é truncado e não deve receber PII (A09) — quem chama passa classe
-- do erro, nunca conteúdo de mensagem.
-- ============================================================
create or replace function public.fail_inbound_messages(
  p_mensagem_ids uuid[],
  p_error        text,
  p_retryable    boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_afetadas int;
begin
  update public.mensagens m
  set processing_started_at = null,
      attempts   = case when p_retryable then m.attempts
                        else public.inbound_max_attempts() end,
      last_error = left(coalesce(p_error, 'erro desconhecido'), 500)
  where m.id = any(p_mensagem_ids)
    and m.direcao = 'inbound'
    and m.processed_at is null;
  get diagnostics v_afetadas = row_count;

  return jsonb_build_object(
    'status',   case when p_retryable then 'requeued' else 'parked' end,
    'afetadas', v_afetadas
  );
end;
$$;

-- ============================================================
-- 7) LEAST-PRIVILEGE — todas server-side.
--
-- Nenhuma destas funções faz sentido a partir do browser: quem processa é a
-- Edge Function, sem sessão de usuário. Mesmo padrão de
-- create_tenant_and_owner e receive_inbound_message.
--
-- inbound_max_attempts() fica legível por authenticated de propósito: é uma
-- constante sem dado nenhum, e uma futura tela de "mensagens travadas" vai
-- querer comparar attempts com o teto.
-- ============================================================
revoke execute on function public.claim_conversation_messages(uuid)
  from public, anon, authenticated;
grant  execute on function public.claim_conversation_messages(uuid)
  to service_role;

revoke execute on function public.reserve_reply(uuid[], text, text)
  from public, anon, authenticated;
grant  execute on function public.reserve_reply(uuid[], text, text)
  to service_role;

revoke execute on function public.confirm_reply(uuid, uuid[], text)
  from public, anon, authenticated;
grant  execute on function public.confirm_reply(uuid, uuid[], text)
  to service_role;

revoke execute on function public.fail_inbound_messages(uuid[], text, boolean)
  from public, anon, authenticated;
grant  execute on function public.fail_inbound_messages(uuid[], text, boolean)
  to service_role;
