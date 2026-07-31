-- Fase 2 (Passo 2a) — o agente nasce junto com o tenant.
--
-- Decisão: todo tenant deve nascer COMPLETO. Um escritório sem agente é estado
-- inválido, então o insert em agentes entra na MESMA transação da RPC de
-- provisionamento (create_tenant_and_owner). Tudo ou nada: se o agente falhar,
-- tenant e owner são revertidos, e a Server Action compensa o auth.users.
--
-- Quando os 4 departamentos chegarem, o padrão já está estabelecido: só muda de
-- 1 para N inserts em agentes dentro desta mesma RPC.

-- ============================================================
-- 1) O system_prompt default mora AQUI, no DEFAULT da coluna — fonte única da
--    verdade. A RPC não repete o texto: insere só o tenant_id e deixa o banco
--    aplicar o default. Qualquer outro caminho de criação de agente (backfill
--    abaixo, futuros departamentos) herda o mesmo ponto de partida.
--
--    É só um PONTO DE PARTIDA: cada escritório edita o seu na tela do agente
--    (Passo 2b/2c). Alterar este default NÃO altera os agentes já criados —
--    proposital, para nunca sobrescrever o texto que o escritório ajustou.
--
--    Dollar-quoting ($prompt$) em vez de aspas simples: o texto tem apóstrofos
--    e várias linhas, e escapar aspas à mão é fonte clássica de erro.
--    btrim(): deixa o texto começar em linha própria (legível no SQL) sem gravar
--    a quebra de linha inicial no valor.
--
--    Os LIMITES do prompt não são só de tom: "não opine sobre imposto/multa do
--    cliente" e "não invente prazo/alíquota" existem porque em contabilidade uma
--    resposta errada gera prejuízo real e responsabilidade para o escritório.
--    A instrução de discrição com CPF/valores é a contrapartida de LGPD no
--    comportamento do agente (o dado já é minimizado no schema).
-- ============================================================
alter table public.agentes
  alter column system_prompt set default btrim($prompt$
Você é o assistente virtual de um escritório de contabilidade brasileiro,
atendendo clientes pelo WhatsApp. Seu papel é ser o primeiro ponto de
contato: acolher, entender a necessidade e encaminhar.

Como se comportar:
- Seja cordial, profissional e objetivo. Use português brasileiro claro,
  sem juridiquês ou termos técnicos desnecessários.
- Responda de forma breve — é uma conversa de WhatsApp, não um e-mail.
- Quando o cliente tiver uma dúvida, ajude no que for informação geral e
  de rotina (horários, documentos comuns, status de solicitações simples).

Limites importantes (nunca ultrapasse):
- NÃO forneça orientação fiscal, tributária, trabalhista ou contábil
  específica que dependa da análise de um profissional. Nesses casos,
  diga que vai encaminhar para a equipe responsável.
- NÃO invente prazos, valores, alíquotas ou informações que você não tem.
  Se não souber, diga que vai verificar com a equipe.
- NÃO confirme, calcule ou opine sobre impostos, multas ou obrigações
  específicas do cliente. Encaminhe para um contador da equipe.
- Ao lidar com dados sensíveis (CPF, valores, documentos), seja discreto
  e não repita esses dados desnecessariamente.

Quando não puder resolver, seja honesto: diga que vai encaminhar para a
equipe do escritório e que alguém retornará. Nunca finja competência que
não tem — em contabilidade, uma informação errada custa caro ao cliente.
$prompt$);

-- ============================================================
-- 2) RPC de provisionamento: agora também cria o agente.
--    Mantém a assinatura (uuid, text, text, text) — a Server Action de signup
--    não muda, e o `create or replace` preserva os grants existentes (mesmo
--    assim eles são reafirmados no fim, para um rebuild do zero ficar correto).
-- ============================================================
create or replace function public.create_tenant_and_owner(
  p_user_id     uuid,
  p_tenant_nome text,
  p_nome        text,
  p_email       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  -- Guarda de negócio: nome do escritório não pode ser vazio (NOT NULL não pega
  -- string em branco). Falha aqui aborta a transação inteira (fail-closed).
  if p_tenant_nome is null or btrim(p_tenant_nome) = '' then
    raise exception 'tenant_nome obrigatório';
  end if;

  insert into public.tenants (nome)
  values (btrim(p_tenant_nome))
  returning id into v_tenant_id;

  insert into public.usuarios (id, tenant_id, nome, email, role)
  values (p_user_id, v_tenant_id, p_nome, p_email, 'owner');

  -- Agente do tenant. nome e system_prompt vêm dos DEFAULTs da tabela (fonte
  -- única) — nada de repetir o texto do prompt aqui. Se este insert falhar, os
  -- dois de cima são revertidos: nunca existe tenant sem agente.
  insert into public.agentes (tenant_id)
  values (v_tenant_id);

  return v_tenant_id;
end;
$$;

-- ============================================================
-- 3) Backfill: tenants criados ANTES desta migration (contas de teste) não têm
--    agente. Sem isso, a tela do Passo 2b abriria vazia para eles e o invariante
--    "todo tenant tem agente" já nasceria falso.
--    Idempotente: o UNIQUE em agentes.tenant_id + on conflict do nothing deixa
--    rodar de novo sem efeito.
-- ============================================================
insert into public.agentes (tenant_id)
select t.id from public.tenants t
on conflict (tenant_id) do nothing;

-- ============================================================
-- 4) Least-privilege reafirmado: provisionar tenant é exclusivamente
--    server-side. Nem uma sessão autenticada no browser executa esta RPC.
-- ============================================================
revoke execute on function public.create_tenant_and_owner(uuid, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.create_tenant_and_owner(uuid, text, text, text)
  to service_role;
