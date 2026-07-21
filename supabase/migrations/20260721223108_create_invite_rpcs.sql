-- Bloco AUTH.3 — RPCs de convite. Todas SECURITY DEFINER + search_path='' e com
-- EXECUTE restrito à service_role (revoke de public/anon/authenticated): mesmo
-- de uma sessão autenticada no browser, chamá-las é NEGADO. Só server-side.

-- ============================================================
-- create_invite: o OWNER gera um convite. tenant_id e role são DERIVADOS da
-- linha do próprio owner (p_owner_id vem do getUser() server-side), nunca de
-- input do cliente. Retorna o token, que a Server Action transforma em link.
-- ============================================================
create or replace function public.create_invite(
  p_owner_id uuid,
  p_email    text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_role      text;
  v_token     text;
begin
  if p_email is null or btrim(p_email) = '' then
    raise exception 'email obrigatório';
  end if;

  -- Deriva tenant e role do PRÓPRIO owner — a fonte de verdade do tenant.
  select tenant_id, role into v_tenant_id, v_role
  from public.usuarios where id = p_owner_id;

  if v_tenant_id is null then
    raise exception 'usuário sem tenant';       -- fail-closed
  end if;
  if v_role <> 'owner' then
    raise exception 'apenas owner pode convidar'; -- só owner convida
  end if;

  -- token/role/status/expires_at vêm dos DEFAULTs da tabela.
  insert into public.convites (tenant_id, email, created_by)
  values (v_tenant_id, lower(btrim(p_email)), p_owner_id)
  returning token into v_token;

  return v_token;
end;
$$;

-- ============================================================
-- get_invite_preview: leitura para a página de aceite mostrar "convite para
-- {escritório}" e travar o e-mail. Devolve 0 linhas se o token for inválido/
-- expirado/usado (a UI mostra erro neutro). Quem chama já tem o token secreto,
-- então expor o e-mail convidado aqui é aceitável.
-- ============================================================
create or replace function public.get_invite_preview(p_token text)
returns table (email text, tenant_nome text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.email, t.nome
  from public.convites c
  join public.tenants t on t.id = c.tenant_id
  where c.token = p_token
    and c.status = 'pending'
    and c.expires_at > now()
$$;

-- ============================================================
-- accept_invite: o CONVIDADO aceita. Transacional (saga: a criação do
-- auth.users e a compensação ficam na Server Action).
--
-- CLAIM ATÔMICO: o UPDATE ... WHERE status='pending' ... RETURNING valida
-- (pendente, não expirado, e-mail bate) E marca 'accepted' numa ÚNICA
-- instrução — impossível usar o mesmo token duas vezes sob concorrência
-- (o segundo aceite não acha status='pending'). tenant_id e role saem do
-- TOKEN, jamais do cliente.
-- ============================================================
create or replace function public.accept_invite(
  p_token   text,
  p_user_id uuid,
  p_nome    text,
  p_email   text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_role      text;
begin
  update public.convites
     set status = 'accepted'
   where token = p_token
     and status = 'pending'
     and expires_at > now()
     and lower(email) = lower(btrim(p_email))
  returning tenant_id, role into v_tenant_id, v_role;

  if not found then
    raise exception 'convite inválido'; -- neutro; a UI não revela a causa
  end if;

  -- Vínculo do funcionário: tenant_id e role vêm do convite validado.
  insert into public.usuarios (id, tenant_id, nome, email, role)
  values (p_user_id, v_tenant_id, p_nome, lower(btrim(p_email)), v_role);

  return v_tenant_id;
end;
$$;

-- ============================================================
-- Least-privilege: as três RPCs só podem ser EXECUTADAS pela service_role.
-- ============================================================
revoke execute on function public.create_invite(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.create_invite(uuid, text)
  to service_role;

revoke execute on function public.get_invite_preview(text)
  from public, anon, authenticated;
grant  execute on function public.get_invite_preview(text)
  to service_role;

revoke execute on function public.accept_invite(text, uuid, text, text)
  from public, anon, authenticated;
grant  execute on function public.accept_invite(text, uuid, text, text)
  to service_role;
