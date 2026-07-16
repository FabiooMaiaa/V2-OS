-- Bloco AUTH.1 — restringe os valores de role.
-- A partir daqui, role controla PERMISSÃO (owner cria/gerencia; member entra
-- por convite). Restringir os valores no banco evita que uma brecha de
-- aplicação grave um role inválido e escale privilégio (defesa-em-profundidade).
alter table public.usuarios
  add constraint usuarios_role_check check (role in ('owner','member'));
