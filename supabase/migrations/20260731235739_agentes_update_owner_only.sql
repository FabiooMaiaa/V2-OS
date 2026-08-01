-- Fase 2 (Passo 2c) — o owner edita o system_prompt do PRÓPRIO tenant.
--
-- Decisão: a trava fica no BANCO, não no código. A Server Action também vai
-- checar role='owner' (falha cedo, mensagem clara), mas se ela esquecer o check
-- por bug ou refactor, o Postgres nega assim mesmo. Mesma filosofia do resto do
-- projeto: nenhuma query confia no frontend para filtrar tenant.
--
-- Por isso NÃO usamos service_role aqui: configurar o agente acontece com uma
-- sessão de owner logado, então dá para deixar o RLS decidir. A service_role
-- fica reservada para quem escreve SEM sessão (o webhook da Evolution).
--
-- Três camadas independentes, nesta ordem de avaliação no Postgres:
--   1) GRANT por COLUNA  -> quais colunas podem ser tocadas
--   2) POLÍTICA USING    -> quais linhas podem ser alvo do update
--   3) POLÍTICA WITH CHECK -> como a linha pode ficar depois do update

-- ============================================================
-- 1) GRANT POR COLUNA — o que a política NÃO consegue fazer.
--
-- Uma policy de RLS filtra LINHAS, nunca COLUNAS: com a policy sozinha, o owner
-- poderia mandar um update em id ou created_at junto do system_prompt. Quem
-- restringe coluna é o GRANT.
--
-- O Supabase concede "all" em public para anon/authenticated por padrão, então
-- é preciso REVOGAR o update amplo antes de conceder o específico. Depois disto,
-- um update em tenant_id/id/created_at é negado ANTES mesmo do RLS rodar.
--
-- updated_at fica DE FORA de propósito: quem escreve é a trigger (bloco 3) —
-- carimbo de tempo não deve ser forjável pelo cliente.
-- service_role não é afetada (mantém acesso total, para o webhook).
-- ============================================================
revoke update on public.agentes from anon, authenticated;
grant  update (nome, system_prompt) on public.agentes to authenticated;

-- ============================================================
-- 2) POLÍTICA DE UPDATE — owner-only, e só do próprio tenant.
--
-- USING      = quais linhas ele pode ALVEJAR (as do tenant dele, se for owner).
-- WITH CHECK = como a linha pode FICAR. É o que impede o owner de "mudar de
--              tenant" a linha: um update que tentasse setar outro tenant_id
--              produziria uma linha que falha o check, e a transação aborta.
--              Sem o WITH CHECK, o USING sozinho deixaria a linha escapar do
--              tenant. (Na prática o GRANT do bloco 1 já barraria, mas as duas
--              defesas são independentes de propósito.)
--
-- (select ...) envolvendo as funções: mesmo padrão das outras políticas do
-- projeto — o Postgres avalia uma vez por query em vez de uma vez por linha.
--
-- INSERT e DELETE seguem SEM política = fail-closed. Criar agente é da RPC de
-- signup (service_role); apagar é só por cascade do tenant (LGPD). Nem o owner
-- cria ou apaga agente pelo cliente.
-- ============================================================
create policy "agentes: owner edita o do proprio tenant"
  on public.agentes
  for update
  to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_owner())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_owner())
  );

-- ============================================================
-- 3) updated_at automático via trigger.
--
-- Por que trigger e não deixar a action mandar o valor: um carimbo de tempo
-- enviado pelo cliente é forjável, e "quando o prompt mudou pela última vez" é
-- informação de auditoria. Com a trigger, vale para QUALQUER caminho de escrita
-- (action do owner hoje, service_role amanhã) sem ninguém precisar lembrar.
--
-- A função é genérica de propósito: instancias_whatsapp também tem updated_at e
-- vai reaproveitá-la quando ganhar escrita, em vez de duplicar a lógica.
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger agentes_set_updated_at
  before update on public.agentes
  for each row
  execute function public.set_updated_at();
