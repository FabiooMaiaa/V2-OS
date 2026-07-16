-- Bloco AUTH.1 — provisionamento atômico do dono + escritório.
--
-- A Fase 1 deixou a ESCRITA em tenants/usuarios fail-closed (sem política): nem
-- um usuário autenticado consegue inserir pelo cliente. Esta RPC é o único
-- caminho de criação, e roda SÓ server-side (ver grants no fim).
--
-- Atomicidade: os dois inserts rodam na transação implícita da função. Se o
-- segundo falhar, o primeiro é revertido — nunca sobra tenant sem dono nem
-- dono sem tenant (a parte "auth.users" da saga é compensada na Server Action).
--
-- SECURITY DEFINER + search_path = '': a função escreve apesar do RLS (roda como
-- o dono, postgres) e fica blindada contra sequestro por search_path (todo
-- objeto é qualificado: public.tenants, public.usuarios).
--
-- role = 'owner' é FIXADO aqui dentro; o caller não escolhe o role → impossível
-- pedir 'owner' por parâmetro. p_user_id vem do auth.users recém-criado.
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

  return v_tenant_id;
end;
$$;

-- Least-privilege (3ª camada da proteção da service_role): a RPC de
-- provisionamento só pode ser EXECUTADA pela service_role. Tira o EXECUTE do
-- PUBLIC e dos grants explícitos que o Supabase dá a anon/authenticated — assim,
-- mesmo de uma sessão autenticada no browser, chamar esta função é NEGADO.
-- Provisionar tenant é exclusivamente server-side.
revoke execute on function public.create_tenant_and_owner(uuid, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.create_tenant_and_owner(uuid, text, text, text)
  to service_role;
