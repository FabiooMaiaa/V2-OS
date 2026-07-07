# V2 OS — Constituição do Projeto

Você é o desenvolvedor deste projeto. Leia estas regras antes de qualquer tarefa.

## O que é o projeto
V2 OS: SaaS multi-tenant, Sistema Operacional para escritórios de
contabilidade brasileiros, com agentes de IA que operam na interface web
e no WhatsApp. Stack: Supabase (DB/Auth/RLS/Edge Functions/pgvector),
Next.js na Vercel, Evolution API no Coolify, Claude API, PostHog.
MVP = apenas o Agente Societário. Arquitetura genérica p/ 4 departamentos,
implementação única.

## Regras de código (SEMPRE)
- Código limpo, sem redundância. Antes de criar algo, verifique se já
  existe função/componente que faça o mesmo. Reutilize em vez de duplicar.
- Comente as linhas de MAIOR relevância explicando o QUE fazem e POR QUE
  importam. Não comente o óbvio (ex.: não comente `const x = 1`). Comente
  lógica de negócio, políticas de segurança, decisões não-óbvias.
- Passos pequenos e testáveis. Nunca faça uma mudança grande de uma vez.
  Ao final de cada mudança, diga exatamente como eu testo se funcionou.
- TypeScript sempre. Nomes de variáveis e funções em inglês; comentários
  em português.
- Se uma tarefa exigir mudar muitos arquivos, PARE e proponha dividir em
  passos antes de executar.

## Multi-tenancy (regra inegociável)
- Isolamento por RLS com coluna `tenant_id` em toda tabela de negócio.
- Nenhuma query confia no frontend para filtrar tenant — o banco bloqueia.
- Em erro de permissão: negar acesso (fail-closed), nunca liberar.

## Segurança — OWASP Top 10:2025 por fase
Aplique a defesa correspondente na fase indicada. Não antecipe defesas de
fases futuras, mas nunca viole as já ativas.
- A01 Broken Access Control → RLS com tenant_id (Fase 1). O nº1 de risco.
- A02 Security Misconfiguration → service_role NUNCA no frontend; RLS
  ligado por padrão; headers de segurança no Next.js; trocar credenciais
  default da Evolution API (Fases 0, 4).
- A03 Software Supply Chain → rodar `npm audit`; Dependabot ativo; não
  instalar pacote desconhecido sem me avisar (contínuo).
- A04 Cryptographic Failures → HTTPS forçado; senhas só via Supabase Auth
  (hash automático); nunca armazenar senha manualmente (Fase 1).
- A05 Injection → queries parametrizadas do Supabase client; nunca montar
  SQL por concatenação de string; validar/sanitizar input do WhatsApp
  antes do agente (Fases 2, 3).
- A06 Insecure Design → planejar antes de codar; rate limiting em
  endpoints sensíveis (Fases 1, 2).
- A07 Authentication Failures → só Supabase Auth; nunca escrever auth
  própria (Fase 1).
- A08 Data Integrity → verificar origem de dependências (contínuo).
- A09 Logging & Alerting → logar eventos sensíveis (login, acesso a dado
  de cliente, ação de agente); NUNCA logar dado pessoal em texto puro
  (Fase 4).
- A10 Mishandling Exceptional Conditions → em erro, negar acesso, nunca
  falhar abrindo (contínuo).

## LGPD (arquitetural desde a Fase 1)
- Minimização: só colete o dado que o agente realmente precisa.
- Isolamento por tenant é a principal defesa prática de LGPD (RLS).
- Direito à exclusão: o schema deve permitir apagar todos os dados de um
  cliente de forma limpa (cascata bem definida).
- Cookies, política de privacidade e termos de uso são da Fase 7, com
  revisão jurídica humana. NÃO gere textos jurídicos definitivos como se
  fossem válidos legalmente.

## Segredos
- Chaves reais só em `.env.local` e nos painéis Vercel/Supabase.
- Nunca escreva uma chave secreta hardcoded no código.
- Só a chave `anon` do Supabase pode aparecer em variáveis públicas
  (NEXT_PUBLIC_*).

## Como trabalhar comigo
- Ao terminar qualquer tarefa, liste: (1) o que mudou e por quê, (2) como
  eu testo, (3) qual o próximo passo sugerido.
- Se discordar de algo que eu pedir por questão técnica ou de segurança,
  me avise uma vez com o motivo, depois execute minha decisão.