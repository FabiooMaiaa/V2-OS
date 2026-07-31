# Notas de Segurança — Vulnerabilidades Conhecidas e Aceitas

_Última atualização: 2026-07-31_

Este arquivo documenta as vulnerabilidades reportadas pelo `npm audit` que já
foram avaliadas e **conscientemente aceitas**, com o motivo de cada uma. É o
lugar para consultar quando o `npm audit` voltar a mostrá-las meses depois —
uma mensagem de commit ninguém relê, este arquivo sim.

## Vulnerabilidades aceitas

| Vulnerabilidade | Severidade | Origem | Status | Motivo |
|---|---|---|---|---|
| `postcss <= 8.5.17` — 3 CVEs: XSS via `</style>` não escapado (GHSA-qx2v-qp2m-jg93); leitura arbitrária de arquivo via `sourceMappingURL` (GHSA-6g55-p6wh-862q); path traversal no auto-load de source map (GHSA-r28c-9q8g-f849) | **High** | Transitiva: `node_modules/next/node_modules/postcss` | **Aceita** | Toolchain de build; não processamos CSS de terceiros; sem fix limpo (ver abaixo) |
| `sharp < 0.35.0` — CVEs herdadas do libvips (CVE-2026-33327/33328/35590/35591, GHSA-f88m-g3jw-g9cj) | **High** | Transitiva: `node_modules/sharp`, puxada pelo `next` | **Aceita** | Só entra em jogo com otimização de imagem do Next; não processamos imagem de terceiros |
| `next` — depende das duas acima | **High** | `node_modules/next` | **Aceita** | Mesma raiz; não é vulnerabilidade própria do Next |

As entradas do `npm audit` têm **duas raízes**, ambas vendorizadas pelo Next para
o próprio build: o `postcss` aninhado e o `sharp`. Em 2026-07-31 o audit reporta
**3 high** (o `postcss` conta como 1 pacote com 3 CVEs).

> **Atualizado em 2026-07-31:** a entrada anterior classificava o postcss como
> _moderate_ com range `< 8.5.10`. Duas CVEs novas (path traversal e leitura
> arbitrária de arquivo, ambas via `sourceMappingURL`) elevaram para **high** e
> ampliaram o range para `<= 8.5.17`. A aceitação **se mantém**, pelo mesmo
> motivo de sempre — o vetor exige CSS controlado pelo atacante em build time,
> e o único CSS que compilamos é o nosso.

**Racional da aceitação (vale para as duas):**

- **Transitivas:** o Next vendoriza o `postcss` aninhado e puxa o `sharp`. Não
  se resolvem por patch nosso: o nosso `postcss` de topo já está corrigido
  (8.5.25), e o vulnerável vive dentro de `node_modules/next/node_modules/`.
  Dependem de um release do Next ou de um `overrides` no `package.json`.
- **Toolchain de build:** esse postcss compila **o nosso próprio CSS**
  (`app/globals.css` + Tailwind). Nenhum CSS controlado por terceiro/usuário
  passa por ele — e as três CVEs exigem exatamente isso: CSS malicioso em build
  time (o `sourceMappingURL` que dispara o path traversal está num comentário de
  CSS de entrada).
- **`sharp` idem:** só é exercitado pela otimização de imagem do Next. Não
  servimos imagem enviada por terceiro; nenhum upload de imagem no produto.
- **Sem exposição em runtime:** nenhuma das duas roda em produção nem no browser
  do usuário final — são ferramentas de build.
- **Sem fix limpo:** o único "fix" que o `npm audit fix --force` oferece é
  rebaixar o Next para 9.3.3 (de 2020, sem App Router), o que quebraria o
  projeto e **reintroduziria CVEs high de runtime**. Trocar 3 high de build por
  um downgrade de 6 majors é estritamente pior — recusado.
- **Não é risco de dado de tenant:** o isolamento por RLS protege os dados
  independentemente destas CVEs de framework, e as CVEs de runtime próprias do
  Next já foram corrigidas no patch para 15.5.22 (commit `4afa9a3`).
- **Acompanhamento:** o Dependabot (`.github/dependabot.yml`) vai propor a
  atualização automaticamente quando o Next bumpar o postcss vendorizado.

**A investigar (passo dedicado, DEPOIS da Fase 2 — decidido em 2026-07-31):**

1. Se algum release do **Next 15.x** já bumpou o `postcss` vendorizado e o
   `sharp` — seria o caminho mais limpo, sem major.
2. Se vale um **`overrides`** do `postcss` no `package.json`, forçando o Next a
   usar a versão corrigida. Precisa de teste de build: o Next pina aquela versão
   por um motivo, e forçar outra pode quebrar a compilação de CSS.

Deliberadamente **não** tratado durante a Fase 2, para não misturar migração de
dependência com a entrega do agente.

## Como revisar

Rode `npm audit` periodicamente. Quando o Next passar a empacotar
`postcss > 8.5.17` e `sharp >= 0.35.0` (confira com `npm ls postcss sharp` — a
linha aninhada sob `next` deve sumir), **remova estas entradas**: elas deixam de
existir e não precisam mais ser documentadas aqui.

## Pendências técnicas conhecidas (não são vulnerabilidades)

- **`process.version` no Edge Runtime (warning de build).** O middleware importa
  o `@supabase/ssr`, que puxa o `@supabase/supabase-js`; este referencia
  `process.version`, uma API Node não suportada no Edge Runtime → warning no
  `next build`. **Não quebra:** o middleware funciona (redirects testados) e o
  supabase-js lida com a ausência. Registrado como pendência, sem correção agora.
  Quando tratar: avaliar rodar o middleware no runtime Node, ou usar um caminho
  do client que não toque `process.version`. Origem: Bloco AUTH.2.

- **Rate limiting de aplicação no login.** Adiado por decisão consciente: o
  Supabase Auth já tem rate limit nativo no vetor principal (brute-force no
  `signInWithPassword`), e limiter in-memory na Vercel serverless é ineficaz
  (security theater). Entra quando houver um store compartilhado. Origem: AUTH.2.

- **SMTP de produção.** O e-mail de confirmação usa o SMTP padrão do Supabase,
  que é lento e não confiável (rate-limited, não recomendado para produção).
  Todo o fluxo de auth (signup do dono e aceite de convite) depende desse
  e-mail. Configurar um SMTP próprio (ex.: Resend/SES/Postmark) na Fase 7.
  Origem: Bloco AUTH.3.

- **Migração do eslint (dev-tooling) — não é mais item de segurança.**
  Registrado no início da Fase 2 como 13 dos 16 alertas high (eslint,
  eslint-plugin-*, glob, minimatch, brace-expansion, flat-cache, rimraf), que
  supostamente só sairiam com **eslint → 9/10**. Em 2026-07-31 o `npm audit`
  não acusa nenhum deles: o total caiu de 16 para **3 high** (`next`, `postcss`,
  `sharp`).
  **Verificado:** o eslint segue em **8.57.1**, ou seja, NÃO foi atualizado — as
  sub-dependências transitivas é que ganharam versão corrigida, e o próprio
  eslint 8.57.1 deixou de ser sinalizado. A migração para eslint 9/10 continua
  desejável (o 8.x está em end-of-life e não recebe mais correção), mas por
  manutenção, **não** por CVE aberta. Sai da fila de segurança.

- **postcss / sharp transitivos do Next.** Ver a seção
  **Vulnerabilidades aceitas** no topo deste arquivo — inclui o racional da
  aceitação e os dois itens a investigar (release do Next 15.x vs. `overrides`).
  Tratar em passo dedicado **depois da Fase 2**. Origem: início da Fase 2,
  reavaliado no Passo 2a.

## Fase 2 — WhatsApp (Evolution API): decisões conscientes

### Escolha da Evolution API (não-oficial) vs. WhatsApp Business API oficial
- **Decisão:** usar Evolution API (self-hosted, via Railway) para o MVP.
- **Trade-off aceito:** a Evolution emula o protocolo do WhatsApp Web e
  NÃO usa a API oficial da Meta. Isso viola os Termos de Serviço do
  WhatsApp e implica risco de banimento do número conectado.
- **Por que mesmo assim:** custo baixo, sem aprovação/verificação da Meta,
  sem taxa por conversa — adequado para validar o produto rapidamente.
- **Mitigação:** usar número secundário/sacrificável em desenvolvimento,
  nunca número pessoal ou de produção crítica. Pinar a versão da imagem
  Docker (não usar `latest`).
- **Rota futura:** avaliar migração para a WhatsApp Business API oficial
  (Meta direto ou provedor como Twilio/360dialog) quando o produto for
  vendido em escala — sem risco de ban, mais "empresarial", porém com
  verificação de negócio, revisão de templates e custo por conversa.

### LGPD — dados de conversa são sensíveis
- Mensagens de clientes de escritórios de contabilidade contêm dados
  pessoais e fiscais (CPF, valores, documentos) sob proteção da LGPD.
- Esses dados trafegam por: Evolution API (Railway), banco (Supabase) e
  API do Claude (Anthropic) durante o processamento.
- `on delete cascade` já garante remoção em cascata ao apagar tenant.
- Pendências a tratar antes de produção real: política de retenção de
  mensagens, atendimento ao direito de exclusão do titular, e revisão
  dos contratos/DPAs dos processadores (Railway, Supabase, Anthropic).

### Segurança do webhook (a implementar no Passo 3)
- O endpoint que recebe eventos da Evolution processa entrada externa
  não confiável. Travas obrigatórias: validação de assinatura/apikey da
  origem, checagem de idempotência (message_id único, evitar
  reprocessamento e cobrança dupla do Claude), e resposta HTTP 200
  imediata (processamento do agente ocorre após responder, para evitar
  timeout e reenvio pela Evolution).
