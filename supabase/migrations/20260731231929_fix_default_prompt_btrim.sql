-- Fase 2 (Passo 2a, correção) — o btrim do default não estava aparando nada.
--
-- BUG: btrim(texto) com UM argumento remove só ESPAÇOS, nunca \n ou \t (o
-- default do segundo argumento é literalmente ' '). Como o prompt começa em
-- linha própria, o valor gravado ficava com "\n" no início e no fim.
-- Detectado pelo teste que compara o começo do prompt com JSON.stringify.
--
-- FIX: passar o conjunto de caracteres explícito — btrim(texto, E' \t\r\n').
-- Lição para os próximos defaults multi-linha: nunca confiar no btrim de 1 arg.

-- ============================================================
-- 1) Corrige o DEFAULT da coluna (segue sendo a fonte única do prompt).
--    O texto é idêntico ao da migration anterior; só o trim mudou.
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
$prompt$, E' \t\r\n');

-- ============================================================
-- 2) Conserta as linhas JÁ criadas com o valor não-aparado (o backfill e
--    qualquer signup feito entre as duas migrations).
--
--    O update apara as PONTAS de qualquer prompt que tenha espaço/quebra
--    sobrando — não só os que estão no texto default. Isso é seguro: espaço em
--    branco nas extremidades de um system_prompt nunca é significativo, e o
--    CONTEÚDO editado por um escritório é preservado byte a byte. O WHERE
--    garante idempotência: rodar de novo não atualiza linha nenhuma.
-- ============================================================
update public.agentes a
set    system_prompt = btrim(a.system_prompt, E' \t\r\n'),
       updated_at    = now()
where  a.system_prompt <> btrim(a.system_prompt, E' \t\r\n');
