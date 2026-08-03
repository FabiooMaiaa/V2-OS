-- Fase 2 (Passo 3a) — RPC de recepção de mensagem do WhatsApp.
--
-- POR QUE UMA RPC E NÃO DOIS INSERTS DO ROUTE HANDLER:
--   1) ATOMICIDADE. Garantir a conversa e gravar a mensagem são duas escritas.
--      Duas chamadas PostgREST são duas transações — se a segunda falhar, sobra
--      conversa sem mensagem. Aqui as duas rodam na transação da função.
--   2) tenant_id NÃO É PARÂMETRO. É resolvido AQUI DENTRO, a partir do
--      instance_name. O caller não tem como pedir outro tenant, nem por bug nem
--      por payload forjado. É o mesmo princípio de create_tenant_and_owner, onde
--      role='owner' é fixado dentro da função.
--
-- Isto importa mais que o normal: o webhook escreve com service_role, que IGNORA
-- o RLS. Sem esta função, o tenant_id viria do código do route handler — e o
-- código seria a única barreira. Aqui o banco derruba a chance de erro.
--
-- SECURITY DEFINER + search_path = '': escreve apesar do RLS e fica blindada
-- contra sequestro por search_path (todo objeto é qualificado).
create or replace function public.receive_inbound_message(
  p_instance_name       text,
  p_external_message_id text,
  p_contato_telefone    text,
  p_contato_nome        text,
  p_conteudo            text
)
returns table (status text, mensagem_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id   uuid;
  v_conversa_id uuid;
  v_mensagem_id uuid;
begin
  -- Guarda de programação, não de input: o endpoint já descarta mensagem sem id
  -- externo (sem ele a idempotência não existe, porque NULL não conflita com
  -- NULL no índice único). Se chegou aqui vazio, é BUG no caller — falha alto em
  -- vez de gravar algo que duplicaria na reentrega.
  if p_external_message_id is null or btrim(p_external_message_id) = '' then
    raise exception 'external_message_id obrigatório';
  end if;

  -- ============================================================
  -- Resolve o TENANT pela instância. Única fonte do tenant_id.
  -- ============================================================
  select i.tenant_id into v_tenant_id
  from public.instancias_whatsapp i
  where i.instance_name = p_instance_name;

  -- Instância desconhecida: fail-closed. NÃO cria tenant, NÃO cria instância,
  -- NÃO grava nada. O endpoint traduz isso em HTTP 200 (erro permanente: pedir
  -- retry à Evolution não resolveria nunca).
  if v_tenant_id is null then
    return query select 'unknown_instance'::text, null::uuid;
    return;
  end if;

  -- ============================================================
  -- Garante a conversa do contato. Note que ultima_mensagem_at NÃO é tocada
  -- aqui: se esta entrega for duplicata, a ordem da lista de conversas não deve
  -- mudar. O carimbo só avança depois de confirmar que a mensagem é nova.
  --
  -- contato_nome com coalesce: o WhatsApp às vezes omite o pushName, e um nome
  -- ausente não deve apagar o nome que já conhecíamos.
  -- ============================================================
  insert into public.conversas as c (tenant_id, contato_telefone, contato_nome)
  values (v_tenant_id, p_contato_telefone, p_contato_nome)
  on conflict (tenant_id, contato_telefone) do update
    set contato_nome = coalesce(excluded.contato_nome, c.contato_nome)
  returning c.id into v_conversa_id;

  -- ============================================================
  -- IDEMPOTÊNCIA. O índice único (tenant_id, external_message_id) é o árbitro:
  -- duas entregas simultâneas disputam este insert, uma ganha e a outra recebe
  -- conflito. Atômico, sem race no código.
  --
  -- v_mensagem_id fica NULL quando o DO NOTHING atua -> duplicata. Esse NULL é o
  -- sinal que impede o endpoint de chamar o Claude duas vezes pela mesma
  -- mensagem (custo real de API).
  -- ============================================================
  insert into public.mensagens (
    tenant_id, conversa_id, direcao, conteudo, external_message_id
  )
  values (
    v_tenant_id, v_conversa_id, 'inbound', p_conteudo, p_external_message_id
  )
  on conflict (tenant_id, external_message_id) do nothing
  returning id into v_mensagem_id;

  if v_mensagem_id is null then
    return query select 'duplicate'::text, null::uuid;
    return;
  end if;

  -- Só agora a conversa sobe na lista: mensagem nova de fato.
  update public.conversas
  set ultima_mensagem_at = now()
  where id = v_conversa_id;

  -- processed_at fica NULL: a mensagem está gravada mas ainda NÃO respondida.
  -- Quem carimba é o processamento do Passo 3b.
  return query select 'inserted'::text, v_mensagem_id;
end;
$$;

-- Least-privilege: só a service_role executa. Mesmo de uma sessão autenticada no
-- browser, chamar esta função é NEGADO — receber mensagem é exclusivamente
-- server-side, a partir do webhook.
revoke execute on function public.receive_inbound_message(text, text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.receive_inbound_message(text, text, text, text, text)
  to service_role;
