-- Bloco AUTH.3 — convite de funcionário (role='member'). Fecha o onboarding.
-- Princípio: tenant_id e role NUNCA vêm de input; vêm do token validado (accept)
-- ou da linha do próprio owner (generate). RLS no padrão da Fase 1 + owner-check.

-- ============================================================
-- is_owner(): true se o usuário LOGADO é owner. Mesmo padrão do
-- current_tenant_id() (SECURITY DEFINER + search_path='' + STABLE): lê usuarios
-- ignorando o RLS (evita recursão) e fica blindado contra sequestro de schema.
-- Usado nas políticas de convites para restringir a gestão ao owner.
-- ============================================================
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.usuarios
    where id = (select auth.uid()) and role = 'owner'
  )
$$;

revoke execute on function public.is_owner() from public, anon;
grant  execute on function public.is_owner() to authenticated;

-- ============================================================
-- convites: um convite amarrado a um e-mail, para entrar num tenant existente
-- como member. Nasce agora, sob demanda.
-- ============================================================
create table public.convites (
  id         uuid primary key default gen_random_uuid(),

  -- tenant do convite: coluna de isolamento. CASCADE atende à LGPD (apagar o
  -- tenant leva seus convites junto).
  tenant_id  uuid not null references public.tenants(id) on delete cascade,

  -- e-mail do convidado: só ESTE e-mail pode aceitar (validado no accept).
  email      text not null,

  -- token SECRETO: 256 bits de CSPRNG (pgcrypto), gerado pelo BANCO via DEFAULT
  -- — nunca pelo cliente nem pelo app. UNIQUE previne colisão. Inadivinhável.
  token      text not null unique
             default encode(extensions.gen_random_bytes(32), 'hex'),

  -- role do convite: fixo 'member'. É copiado para usuarios no accept — o
  -- convidado nunca escolhe o próprio papel.
  role       text not null default 'member' check (role in ('owner', 'member')),

  status     text not null default 'pending'
             check (status in ('pending', 'accepted', 'revoked', 'expired')),

  -- Expiração de 7 dias por DEFAULT (expiração "preguiçosa": checada no accept).
  expires_at timestamptz not null default (now() + interval '7 days'),

  -- quem criou (o owner). CASCADE mantém a limpeza consistente.
  created_by uuid not null references public.usuarios(id) on delete cascade,

  created_at timestamptz not null default now()
);

-- Índice em tenant_id: o RLS filtra por ele (o índice de token já vem do UNIQUE).
create index convites_tenant_id_idx on public.convites (tenant_id);

-- ============================================================
-- RLS (A01). SELECT só para o OWNER, e só do PRÓPRIO tenant.
-- ESCRITA sem política = fail-closed: criar/aceitar convite é exclusivamente
-- server-side via RPC service_role (ver migration seguinte). Em especial, o
-- CONVIDADO não tem linha em usuarios → current_tenant_id() é NULL → ele não
-- consegue ler convites por SELECT; valida o token pela RPC service_role.
-- ============================================================
alter table public.convites enable row level security;

create policy "convites: owner ve os do proprio tenant"
  on public.convites
  for select
  to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_owner())
  );
