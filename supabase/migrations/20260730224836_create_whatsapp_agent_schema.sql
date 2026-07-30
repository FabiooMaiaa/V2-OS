-- Fase 2 (Passo 1) — schema do WhatsApp + agente.
-- Todas as tabelas seguem o padrão da Fase 1: tenant_id + RLS com
-- current_tenant_id(); SELECT tenant-wide para membros; ESCRITA fail-closed
-- (webhook inbound e envio outbound gravam server-side via service_role);
-- on delete cascade para atender à LGPD (apagar o tenant limpa tudo).

-- ============================================================
-- agentes: config do agente de IA do tenant (onde mora o system_prompt).
-- MVP = 1 agente por tenant (Agente Societário) → tenant_id UNIQUE. Para os 4
-- departamentos no futuro, relaxar o UNIQUE e adicionar um campo de tipo.
-- ============================================================
create table public.agentes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null unique references public.tenants(id) on delete cascade,
  nome          text not null default 'Agente Societário',
  system_prompt text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- instancias_whatsapp: a conexão Evolution do tenant. 1 por tenant no MVP
-- (tenant_id UNIQUE). instance_name é o identificador na Evolution (global).
-- ============================================================
create table public.instancias_whatsapp (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null unique references public.tenants(id) on delete cascade,
  instance_name text not null unique,
  phone_number  text,
  status        text not null default 'disconnected'
                check (status in ('disconnected', 'connecting', 'connected')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- conversas: uma conversa por contato do tenant.
-- ============================================================
create table public.conversas (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  contato_telefone   text not null,          -- número do cliente (remoteJid)
  contato_nome       text,                   -- push name (pode faltar)
  ultima_mensagem_at timestamptz,            -- para ordenar a lista de conversas
  created_at         timestamptz not null default now(),
  -- Uma conversa por contato dentro do tenant (o webhook faz upsert por aqui).
  unique (tenant_id, contato_telefone)
);
create index conversas_tenant_ultima_idx
  on public.conversas (tenant_id, ultima_mensagem_at desc);

-- ============================================================
-- mensagens: cada mensagem trocada.
-- ============================================================
create table public.mensagens (
  id          uuid primary key default gen_random_uuid(),

  -- tenant_id DENORMALIZADO (além de conversa_id): deixa o RLS direto e rápido
  -- (tenant_id = current_tenant_id()), sem subquery via conversa. O server
  -- mantém os dois consistentes no insert.
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  conversa_id uuid not null references public.conversas(id) on delete cascade,

  direcao     text not null check (direcao in ('inbound', 'outbound')),

  -- LGPD: conteúdo em TEXTO PURO por ora. CANDIDATO A CIFRAGEM no futuro —
  -- pré-requisito antes de um escritório real usar em produção. NÃO persistimos
  -- mídia binária (áudio/imagem/PDF): anexo vira só referência textual, ex.:
  -- "[áudio recebido]" — reduz a superfície de dado sensível.
  conteudo    text not null default '',

  -- id da mensagem no WhatsApp. UNIQUE por tenant = IDEMPOTÊNCIA do webhook:
  -- reentrega da Evolution não duplica a mensagem nem dispara o Claude 2x
  -- (o insert usa on conflict (tenant_id, external_message_id) do nothing).
  external_message_id text,

  status      text,                          -- outbound: sent/delivered/read/failed
  created_at  timestamptz not null default now(),

  unique (tenant_id, external_message_id)
);
create index mensagens_conversa_idx on public.mensagens (conversa_id, created_at);
create index mensagens_tenant_idx   on public.mensagens (tenant_id);

-- ============================================================
-- RLS (A01). SELECT tenant-wide para membros; ESCRITA sem política = fail-closed
-- (inbound via webhook e outbound via ação de envio gravam com service_role,
-- que ignora o RLS). Nada de escrita a partir do cliente.
-- ============================================================
alter table public.agentes             enable row level security;
alter table public.instancias_whatsapp enable row level security;
alter table public.conversas           enable row level security;
alter table public.mensagens           enable row level security;

create policy "agentes: ver do proprio tenant"
  on public.agentes for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));

create policy "instancias: ver do proprio tenant"
  on public.instancias_whatsapp for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));

create policy "conversas: ver do proprio tenant"
  on public.conversas for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));

create policy "mensagens: ver do proprio tenant"
  on public.mensagens for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
