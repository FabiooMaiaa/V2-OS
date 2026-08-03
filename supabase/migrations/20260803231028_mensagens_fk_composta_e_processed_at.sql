-- Fase 2 (Passo 3a, pré-requisito) — integridade cruzada de tenant + marcador
-- de processamento em mensagens.
--
-- CONTEXTO QUE MOTIVA ESTA MIGRATION: o webhook da Evolution escreve SEM sessão,
-- logo com service_role, que IGNORA o RLS. É a inversão do Passo 2: lá o banco
-- era a trava e o código podia errar sem consequência; aqui o código passaria a
-- ser a única barreira. Esta migration devolve parte da garantia ao banco.
--
-- Tabelas estavam VAZIAS ao aplicar (conversas 0, mensagens 0), então nenhuma
-- constraint abaixo pode falhar por dado pré-existente e nada precisa de
-- backfill.

-- ============================================================
-- 1) FK COMPOSTA — torna fisicamente impossível cruzar tenants.
--
-- mensagens.tenant_id é DENORMALIZADO (existe além de conversa_id) para o RLS
-- ficar direto e rápido. O preço dessa denormalização é poder divergir: um bug
-- no webhook poderia gravar mensagem com tenant_id de A e conversa_id de B,
-- vazando conteúdo de um escritório para dentro da conversa de outro.
--
-- A FK composta remove essa possibilidade do domínio do código: o par
-- (conversa_id, tenant_id) precisa existir JUNTO em conversas. Com service_role
-- ignorando o RLS, esta é a defesa que sobra — e ela não depende de eu acertar.
--
-- Pré-requisito: o alvo de uma FK tem que ser UNIQUE. conversas.id já é PK, mas
-- o PAR (id, tenant_id) não era único formalmente — daí o unique abaixo. É
-- redundante em termos de dado (id sozinho já é único) e necessário em termos de
-- catálogo, para o Postgres aceitar referenciar o par.
-- ============================================================
alter table public.conversas
  add constraint conversas_id_tenant_key unique (id, tenant_id);

alter table public.mensagens
  add constraint mensagens_conversa_tenant_fkey
  foreign key (conversa_id, tenant_id)
  references public.conversas (id, tenant_id)
  on delete cascade;

-- A FK antiga (só conversa_id) fica REDUNDANTE: a composta já garante que a
-- conversa existe, e com o tenant certo. Duas FKs para a mesma tabela seriam
-- duas checagens por insert sem ganho.
--
-- `if exists` porque o nome foi gerado pelo Postgres e eu não pude inspecionar o
-- catálogo (sem Docker/psql nesta máquina). Se o nome real for outro, este DROP
-- não faz nada e sobra a constraint redundante — overhead pequeno, nunca um bug.
-- Vale confirmar depois com a query de verificação (ver relatório).
alter table public.mensagens
  drop constraint if exists mensagens_conversa_id_fkey;

-- ============================================================
-- 2) processed_at — distingue "gravada" de "gravada E respondida".
--
-- POR QUE A COLUNA EXISTE: a idempotência do webhook usa "conseguiu inserir?"
-- como gatilho do processamento (UNIQUE tenant_id + external_message_id). Isso
-- cria um buraco: se o processo morrer DEPOIS do insert e ANTES de responder ao
-- cliente, a reentrega da Evolution vê duplicata e PULA — e a mensagem do
-- cliente fica sem resposta, em silêncio.
--
-- NULL = ainda não processada. A varredura de órfãs vem no Passo 3b; a coluna
-- entra agora porque prever o campo é barato e alterar schema depois custa mais.
-- ============================================================
alter table public.mensagens
  add column processed_at timestamptz;

-- Índice PARCIAL: indexa só o que a varredura procura (inbound pendente). Como
-- a esmagadora maioria das linhas será processada, o índice fica minúsculo — e
-- some da prática assim que a fila esvazia. Um índice comum sobre processed_at
-- carregaria todas as mensagens já respondidas, sem utilidade.
create index mensagens_pendentes_idx
  on public.mensagens (created_at)
  where direcao = 'inbound' and processed_at is null;

-- ============================================================
-- 3) ESCRITA SEGUE FAIL-CLOSED — nada de política nova.
--
-- mensagens e conversas continuam sem política de INSERT/UPDATE/DELETE: quem
-- grava é o webhook via service_role. processed_at em particular é carimbo
-- interno de processamento — nenhum usuário autenticado tem por que escrevê-lo.
-- Registrado explicitamente para o leitor futuro não achar que faltou algo.
-- ============================================================
