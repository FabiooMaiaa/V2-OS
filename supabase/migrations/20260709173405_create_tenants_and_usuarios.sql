-- Bloco 1.1 — fundação do modelo de dados multi-tenant.
-- Cria as duas tabelas-raiz do isolamento (tenants e usuarios) e liga o RLS.
-- As políticas completas de tenant vêm no próximo bloco (1.2).

-- ============================================================
-- tenants: a raiz do isolamento. Cada linha é um escritório de
-- contabilidade (um cliente do SaaS). Todo dado de negócio, no futuro,
-- pendura em um tenant_id que aponta para cá.
-- ============================================================
create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- usuarios: liga cada usuário autenticado (auth.users, gerido pelo
-- Supabase Auth) a exatamente um tenant.
-- ============================================================
create table public.usuarios (
  -- O id do usuário É o id do auth.users (relação 1:1). ON DELETE CASCADE:
  -- apagar a conta de auth remove automaticamente esta linha.
  id         uuid primary key references auth.users(id) on delete cascade,

  -- tenant_id é a COLUNA DE ISOLAMENTO: é por ela que o RLS vai decidir,
  -- no bloco seguinte, qual usuário enxerga quais dados. NOT NULL para
  -- que nunca exista usuário "sem tenant" (evita vazamento por brecha).
  -- ON DELETE CASCADE atende à LGPD (excluir um tenant apaga seus usuários).
  tenant_id  uuid not null references public.tenants(id) on delete cascade,

  nome       text,
  email      text not null,
  role       text not null default 'member',
  created_at timestamptz not null default now()
);

-- Índice em tenant_id: o RLS filtra por esta coluna em toda query; sem
-- índice, cada checagem de política vira um scan. Também acelera a FK.
create index usuarios_tenant_id_idx on public.usuarios (tenant_id);

-- ============================================================
-- Row Level Security (OWASP A01 — Broken Access Control, o nº1 de risco).
-- Ligar o RLS é fail-closed: com o RLS ativo e SEM política, o Postgres
-- NEGA todo acesso por padrão. Assim, mesmo que o frontend erre, o banco
-- bloqueia. As políticas abrem o acesso de forma controlada (bloco 1.2).
-- ============================================================
alter table public.tenants  enable row level security;
alter table public.usuarios enable row level security;

-- Política MÍNIMA e segura: um usuário pode ler apenas a PRÓPRIA linha em
-- usuarios (id = auth.uid()). É a base da abordagem "descobrir o tenant
-- via tabela usuarios" que o bloco 1.2 vai usar. Continua fail-closed:
-- só a própria linha, nada de outros usuários ou outros tenants.
create policy "usuarios: ler a própria linha"
  on public.usuarios
  for select
  using (id = (select auth.uid()));

-- Obs.: tenants fica com RLS ligado e SEM política de propósito — ou seja,
-- totalmente bloqueada até o bloco 1.2 definir quem pode lê-la/gravá-la.
