/**
 * Verificação do agente (Fase 2, Passos 2a e 2c).
 *
 * Prova invariantes contra o banco REMOTO, em vez de confiar na leitura do SQL.
 * Foi este script que pegou o bug do btrim de 1 argumento (que remove só
 * espaços, nunca \n) — o \n é invisível num print normal, e só apareceu porque
 * o teste 3 imprime o valor com JSON.stringify.
 *
 * Uso:  node scripts/verify-agente-seed.mjs     (ou: npm run verify:agente)
 * Sai com código 1 se qualquer teste falhar (serve em CI).
 *
 * Testes 1-3 (service_role): seed, atomicidade e formato do prompt.
 * Testes 4-7 (sessão real):  o RLS de UPDATE. Só rodam se as TEST_* estiverem
 *   no .env.local; sem elas, são PULADOS com aviso (não falham o script).
 *
 * SEGREDOS: nada é hardcoded aqui. Tudo vem do .env.local, que é gitignored, e
 * NENHUM valor é impresso — nem chave, nem e-mail, nem senha (A09).
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

// Client ADMIN: ignora o RLS. Usado só para INSPECIONAR o estado do banco nos
// testes 1-3 — nunca para provar permissão (provar permissão com service_role
// não provaria nada: ela passa por cima de tudo).
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

/** Loga com e-mail/senha e devolve um client ANON com a sessão — igual ao browser. */
async function signIn(email, password) {
  const c = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } },
  )
  const { error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error('login falhou: ' + error.message)
  return c
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

// ============================================================
// TESTES 4-7 — o RLS de UPDATE (Passo 2c), com SESSÃO REAL.
//
// Só têm valor com client ANON + sessão de verdade: é exatamente o que o
// browser usa. Com service_role tudo passaria e não provaria nada.
// ============================================================
const TEST_VARS = [
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'TEST_OWNER_EMAIL',
  'TEST_OWNER_PASSWORD',
  'TEST_MEMBER_EMAIL',
  'TEST_MEMBER_PASSWORD',
]
const faltando = TEST_VARS.filter((k) => !env[k])

if (faltando.length) {
  console.log('\n=== TESTES 4-7 (RLS de UPDATE): PULADOS ===')
  console.log('Faltam no .env.local:', faltando.join(', '))
  console.log('Veja .env.example. Sem eles o RLS de escrita NAO foi verificado.')
} else {
  const owner = await signIn(env.TEST_OWNER_EMAIL, env.TEST_OWNER_PASSWORD)
  const member = await signIn(env.TEST_MEMBER_EMAIL, env.TEST_MEMBER_PASSWORD)

  // Estado original, para restaurar no fim: o teste não pode deixar o prompt
  // alterado no banco.
  const { data: antes } = await db
    .from('agentes')
    .select('id, tenant_id, system_prompt, updated_at')
    .single()

  // ---------- TESTE 4: member NÃO pode editar ----------
  // SUTILEZA: um UPDATE barrado pelo USING do RLS não devolve ERRO — ele
  // simplesmente não casa nenhuma linha. Por isso a asserção é sobre a
  // CONTAGEM de linhas afetadas (via .select()), não sobre error != null.
  // Checar só o erro daria falso "passou".
  const { data: mUpd, error: mErr } = await member
    .from('agentes')
    .update({ system_prompt: 'INVASAO PELO MEMBER' })
    .eq('id', antes.id)
    .select('id')

  const { data: depoisMember } = await db
    .from('agentes')
    .select('system_prompt')
    .eq('id', antes.id)
    .single()

  const memberBarrado =
    (mUpd ?? []).length === 0 &&
    depoisMember.system_prompt === antes.system_prompt

  console.log('\n=== TESTE 4: member tenta editar o prompt ===')
  console.log('linhas afetadas:', (mUpd ?? []).length, '(esperado 0)')
  console.log('erro retornado :', mErr ? mErr.message : '(nenhum — esperado: RLS nao casa linha)')
  console.log('prompt intacto :', depoisMember.system_prompt === antes.system_prompt)
  console.log('RESULTADO:', resultado(memberBarrado))

  // ---------- TESTE 5: owner PODE editar (e a trigger carimba) ----------
  const NOVO = antes.system_prompt + '\n\n[marcador de teste]'
  const { data: oUpd, error: oErr } = await owner
    .from('agentes')
    .update({ system_prompt: NOVO })
    .eq('id', antes.id)
    .select('id, system_prompt, updated_at')

  const gravou = (oUpd ?? []).length === 1 && oUpd[0].system_prompt === NOVO
  // A trigger set_updated_at() deve ter mexido no carimbo sem ninguém pedir.
  const carimbou =
    gravou && new Date(oUpd[0].updated_at) > new Date(antes.updated_at)

  console.log('\n=== TESTE 5: owner edita o prompt ===')
  console.log('linhas afetadas:', (oUpd ?? []).length, '(esperado 1)')
  console.log('erro retornado :', oErr ? oErr.message : '(nenhum)')
  console.log('texto gravado  :', gravou)
  console.log('updated_at avancou (trigger):', carimbou)
  console.log('RESULTADO:', resultado(gravou && carimbou))

  // ---------- TESTE 6: nem o owner muda o tenant_id ----------
  // Aqui o bloqueio é do GRANT POR COLUNA, que roda ANTES do RLS: authenticated
  // só tem update em (nome, system_prompt). Por ser negação de privilégio, este
  // caso SIM devolve erro (42501), diferente do teste 4.
  const { error: tErr } = await owner
    .from('agentes')
    .update({ tenant_id: '00000000-0000-0000-0000-000000000000' })
    .eq('id', antes.id)
    .select('id')

  const { data: depoisTenant } = await db
    .from('agentes')
    .select('tenant_id')
    .eq('id', antes.id)
    .single()

  const tenantIntacto = depoisTenant.tenant_id === antes.tenant_id

  console.log('\n=== TESTE 6: owner tenta mudar o tenant_id ===')
  console.log('erro retornado:', tErr ? tErr.message : 'NENHUM (!!)')
  console.log('tenant_id intacto:', tenantIntacto)
  console.log('RESULTADO:', resultado(Boolean(tErr) && tenantIntacto))

  // ---------- TESTE 7: INSERT e DELETE seguem fail-closed ----------
  // Sem política para insert/delete, nem o owner cria ou apaga agente pelo
  // cliente. Criar é da RPC de signup; apagar é só por cascade do tenant (LGPD).
  const { error: iErr } = await owner
    .from('agentes')
    .insert({ tenant_id: antes.tenant_id, system_prompt: 'x' })
    .select('id')

  const { data: dDel } = await owner
    .from('agentes')
    .delete()
    .eq('id', antes.id)
    .select('id')

  const { count: aindaExiste } = await db
    .from('agentes')
    .select('id', { count: 'exact', head: true })
    .eq('id', antes.id)

  const failClosed = Boolean(iErr) && (dDel ?? []).length === 0 && aindaExiste === 1

  console.log('\n=== TESTE 7: insert/delete fail-closed (owner) ===')
  console.log('insert negou? :', iErr ? 'sim — ' + iErr.message : 'NAO (!!)')
  console.log('delete afetou :', (dDel ?? []).length, 'linhas (esperado 0)')
  console.log('agente continua existindo:', aindaExiste === 1)
  console.log('RESULTADO:', resultado(failClosed))

  // ---------- Limpeza: devolve o prompt original ----------
  // Via service_role, para restaurar mesmo que algum teste acima tenha deixado
  // o banco num estado inesperado.
  await db
    .from('agentes')
    .update({ system_prompt: antes.system_prompt })
    .eq('id', antes.id)

  const { data: final } = await db
    .from('agentes')
    .select('system_prompt')
    .eq('id', antes.id)
    .single()

  console.log('\n=== Limpeza ===')
  console.log(
    'prompt restaurado ao original:',
    final.system_prompt === antes.system_prompt,
  )
  if (final.system_prompt !== antes.system_prompt) falhou = true
}

console.log('\n' + (falhou ? '>>> HOUVE FALHA' : '>>> TODOS PASSARAM'))
process.exit(falhou ? 1 : 0)
