/**
 * Verificação do provisionamento do agente (Fase 2, Passo 2a).
 *
 * Prova três invariantes contra o banco REMOTO, em vez de confiar na leitura do
 * SQL. Foi este script que pegou o bug do btrim de 1 argumento (que remove só
 * espaços, nunca \n) — o \n é invisível num print normal, e só apareceu porque
 * o teste 3 imprime o valor com JSON.stringify.
 *
 * Uso:  node scripts/verify-agente-seed.mjs
 * Sai com código 1 se qualquer teste falhar (serve em CI).
 *
 * SEGREDOS: nada é hardcoded aqui. Lê NEXT_PUBLIC_SUPABASE_URL e
 * SUPABASE_SERVICE_ROLE_KEY do .env.local (que é gitignored) e NUNCA imprime os
 * valores. Usa service_role para ignorar o RLS e ver todos os tenants — por isso
 * roda SÓ localmente/CI, jamais no browser (A02).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

// Caminho relativo AO SCRIPT, não ao cwd: rodar de qualquer pasta funciona.
const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local')

const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1).trim()]
    }),
)

for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[k]) {
    console.error(`Falta ${k} em .env.local`)
    process.exit(1)
  }
}

const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

let falhou = false
const resultado = (passou) => {
  if (!passou) falhou = true
  return passou ? 'PASSOU' : 'FALHOU'
}

// ---------- TESTE 1: todo tenant tem agente ----------
// Invariante do Passo 2a: o agente nasce com o tenant, e o backfill cobriu os
// tenants antigos. Anti-join via embed: agentes vazio = tenant órfão.
const { data: tenants, error: e1 } = await db
  .from('tenants')
  .select('id, nome, created_at, agentes(id)')
  .order('created_at')

if (e1) throw new Error('teste 1: ' + e1.message)
const semAgente = tenants.filter((t) => !t.agentes || t.agentes.length === 0)

console.log('=== TESTE 1: tenants sem agente ===')
console.log('total de tenants  :', tenants.length)
console.log('tenants SEM agente:', semAgente.length, '(esperado 0)')
if (semAgente.length) console.log('  ->', semAgente.map((t) => t.nome))
console.log('RESULTADO:', resultado(semAgente.length === 0))

// ---------- TESTE 2: atomicidade (tudo-ou-nada) ----------
// Não há BEGIN/ROLLBACK via PostgREST, então provamos algo MAIS FORTE que um
// rollback manual (que sempre desfaz e não testa a função): forçamos uma falha
// REAL no meio da RPC. p_user_id é um uuid inexistente em auth.users -> o insert
// em usuarios viola a FK -> a função aborta. Se o tenant do 1º insert não
// sobrar, a transação é atômica de fato. Não suja o banco: nada é commitado.
const NOME_TESTE = 'Teste Rollback'
const { error: eRpc } = await db.rpc('create_tenant_and_owner', {
  p_user_id: '00000000-0000-0000-0000-000000000000',
  p_tenant_nome: NOME_TESTE,
  p_nome: 'X',
  p_email: 'x@y.com',
})

const { data: sobrou, error: e2 } = await db
  .from('tenants')
  .select('id, nome')
  .eq('nome', NOME_TESTE)

if (e2) throw new Error('teste 2: ' + e2.message)

console.log('\n=== TESTE 2: atomicidade (falha forcada no meio da RPC) ===')
console.log('a RPC falhou como esperado?:', eRpc ? 'sim' : 'NAO (!!)')
console.log('  motivo:', eRpc ? eRpc.message : '(nenhum)')
console.log(`tenants "${NOME_TESTE}" que sobraram:`, sobrou.length, '(esperado 0)')
console.log('RESULTADO:', resultado(Boolean(eRpc) && sobrou.length === 0))

// ---------- TESTE 3: o prompt default está aparado ----------
// JSON.stringify é o ponto do teste: expõe \n ou espaço nas pontas que o olho
// não vê no terminal. Foi assim que o btrim quebrado apareceu.
const { data: agentes, error: e3 } = await db
  .from('agentes')
  .select('tenant_id, nome, system_prompt')

if (e3) throw new Error('teste 3: ' + e3.message)

const ESPERADO = 'Você é o assistente virtual'
console.log('\n=== TESTE 3: prompt sem espaco/quebra nas pontas ===')
console.log('agentes encontrados:', agentes.length)

let todosOk = agentes.length > 0
for (const a of agentes) {
  const p = a.system_prompt ?? ''
  // Só checa o texto esperado nos prompts ainda no default: um escritório que
  // editou o seu pode legitimamente começar diferente. O trim vale para todos.
  const noDefault = p.startsWith(ESPERADO)
  const aparado = p === p.trim()
  console.log('  primeiros 40 chars (escapado):', JSON.stringify(p.slice(0, 40)))
  console.log('  tamanho:', p.length, '| no texto default:', noDefault, '| aparado:', aparado)
  if (!aparado) todosOk = false
}
console.log('RESULTADO:', resultado(todosOk))

console.log('\n' + (falhou ? '>>> HOUVE FALHA' : '>>> TODOS PASSARAM'))
process.exit(falhou ? 1 : 0)
