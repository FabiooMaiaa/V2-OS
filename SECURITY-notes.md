# Notas de Segurança — Vulnerabilidades Conhecidas e Aceitas

_Última atualização: 2026-07-16_

Este arquivo documenta as vulnerabilidades reportadas pelo `npm audit` que já
foram avaliadas e **conscientemente aceitas**, com o motivo de cada uma. É o
lugar para consultar quando o `npm audit` voltar a mostrá-las meses depois —
uma mensagem de commit ninguém relê, este arquivo sim.

## Vulnerabilidades aceitas

| Vulnerabilidade | Severidade | Origem | Status | Motivo |
|---|---|---|---|---|
| `postcss < 8.5.10` — XSS via `</style>` não escapado no stringify (GHSA-qx2v-qp2m-jg93) | Moderate | Transitiva: `node_modules/next/node_modules/postcss@8.4.31` | **Aceita** | Toolchain de build; sem exposição em runtime; sem fix limpo (ver abaixo) |
| `next` — depende do postcss vulnerável acima | Moderate | `node_modules/next` → postcss@8.4.31 empacotado | **Aceita** | Mesma cadeia do postcss; é a mesma raiz do problema |

As duas entradas do `npm audit` são a **mesma raiz**: o Next empacota
`postcss@8.4.31` para o próprio processo de build.

**Racional da aceitação (vale para as duas):**

- **Transitiva:** o Next fixa `postcss@8.4.31` como dependência — vale tanto
  para a 15.5.20 (instalada) quanto para a 16.2.10. Não há versão do Next que
  traga um postcss corrigido.
- **Toolchain de build:** esse postcss compila **o nosso próprio CSS**
  (`app/globals.css` + Tailwind). Nenhum CSS controlado por terceiro/usuário
  passa por ele. O postcss de topo (o do Tailwind) já é 8.5.15, corrigido.
- **Sem exposição em runtime:** não roda em produção nem no browser do usuário
  final — é ferramenta de build.
- **Sem fix limpo:** o único "fix" que o `npm audit fix --force` oferece é
  rebaixar o Next para 9.3.3 (de 2020, sem App Router), o que quebraria o
  projeto e **reintroduziria 14 CVEs high**. Trocar 2 moderate de build por 14
  high de runtime é estritamente pior — recusado.
- **Acompanhamento:** o Dependabot (`.github/dependabot.yml`) vai propor a
  atualização automaticamente quando o Next bumpar o postcss vendorizado.

## Como revisar

Rode `npm audit` periodicamente. Quando o Next passar a empacotar
`postcss >= 8.5.10` (confira com `npm ls postcss` — a linha aninhada sob
`next` deve sumir), **remova estas entradas**: elas deixam de existir e não
precisam mais ser documentadas aqui.

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
