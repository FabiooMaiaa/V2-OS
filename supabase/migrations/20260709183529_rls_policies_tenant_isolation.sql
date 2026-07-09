-- Bloco 1.2 — políticas RLS completas (isolamento por tenant).
-- ESTE É O BLOCO MAIS CRÍTICO: política errada não gera erro, vaza dado
-- calado. Estratégia: descobrir o tenant do usuário logado via tabela
-- usuarios (NÃO via JWT claims). Fail-closed em tudo.

-- ============================================================
-- current_tenant_id(): retorna o tenant_id do usuário LOGADO, lido da
-- tabela usuarios onde id = auth.uid(). É o coração do isolamento —
-- toda política de tenant chama esta função.
--
-- SECURITY DEFINER (roda com os privilégios do DONO da função, o postgres,
-- que é dono das tabelas e ignora o RLS): é OBRIGATÓRIO aqui porque a
-- função LÊ a tabela usuarios, e as políticas DE usuarios chamam esta
-- função. Se fosse SECURITY INVOKER, o SELECT interno dispararia de novo
-- a política de usuarios, que chamaria a função de novo → recursão
-- infinita (o Postgres aborta com "infinite recursion detected in policy").
-- Como DEFINER, o SELECT interno não passa pelo RLS e a recursão não ocorre.
--
-- SET search_path = '' (vazio): blindagem de SECURITY DEFINER. Sem isso,
-- um atacante poderia criar um objeto homônimo (ex.: uma tabela "usuarios"
-- em outro schema no seu search_path) e sequestrar a função, que roda com
-- privilégio elevado. Com search_path vazio, TODO objeto é qualificado
-- explicitamente (public.usuarios, auth.uid()) — nada é resolvido por busca.
--
-- STABLE: o resultado não muda dentro da mesma query (permite o planner
-- cachear a chamada). Sem parâmetros e sem entrada externa: a função só
-- olha auth.uid() (o próprio usuário) — impossível pedir o tenant de outro.
--
-- Sem linha em usuarios → o SELECT devolve NULL. E NULL desliga o acesso:
-- em SQL, "coluna = NULL" nunca é verdadeiro, então as políticas negam
-- (fail-closed) para usuário sem tenant.
-- ============================================================
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tenant_id
  from public.usuarios
  where id = (select auth.uid())
$$;

-- Execução da função: tira o EXECUTE do PUBLIC e concede ao authenticated
-- (as políticas dependem dele). ATENÇÃO: o Supabase também concede EXECUTE a
-- anon/authenticated/service_role via default privileges — grants explícitos,
-- independentes do PUBLIC —, então o revoke abaixo NÃO barra o anon sozinho;
-- isso é feito na migration seguinte (revoke ... from anon). Ainda assim, o
-- isolamento NÃO depende disso: as políticas são "to authenticated" e a função
-- retorna NULL para quem não tem auth.uid() — anon nunca enxerga dado.
revoke execute on function public.current_tenant_id() from public;
grant  execute on function public.current_tenant_id() to authenticated;

-- ============================================================
-- Políticas de RLS. Todas com "to authenticated": anon não tem NENHUMA
-- política permissiva → o Postgres nega tudo para anon (fail-closed).
--
-- (select public.current_tenant_id()): o subselect faz a função rodar uma
-- vez por query (initPlan), não uma vez por linha — desempenho, mesmo
-- resultado.
-- ============================================================

-- usuarios / SELECT: enxergar os colegas do MESMO tenant.
-- Substitui a política mínima "ler a própria linha" do bloco 1.1 (ver
-- explicação abaixo): a própria linha já está contida em "mesmo tenant".
drop policy "usuarios: ler a própria linha" on public.usuarios;

create policy "usuarios: ver membros do mesmo tenant"
  on public.usuarios
  for select
  to authenticated
  using (tenant_id = (select public.current_tenant_id()));

-- tenants / SELECT: enxergar APENAS o próprio tenant (a linha cujo id é o
-- tenant do usuário logado). Nunca lista os outros escritórios.
create policy "tenants: ver apenas o próprio tenant"
  on public.tenants
  for select
  to authenticated
  using (id = (select public.current_tenant_id()));

-- ESCRITA (INSERT/UPDATE/DELETE) em tenants e usuarios: NENHUMA política
-- de propósito. Com RLS ligado e sem política de escrita, toda gravação
-- pelo cliente é NEGADA (fail-closed). Provisionar tenant/usuário será um
-- fluxo controlado server-side (service_role, que ignora o RLS) — não se
-- confia no frontend para criar/alterar vínculo de tenant.
