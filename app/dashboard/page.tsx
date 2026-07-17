import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logout } from './actions'

export const metadata: Metadata = {
  title: 'Painel — V2 OS',
}

export default async function DashboardPage() {
  const supabase = await createClient()

  // Defesa em profundidade: NÃO confiamos só no middleware (que é conveniência
  // e já teve CVE de bypass). A página revalida a sessão no servidor.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // Leitura via SERVER CLIENT (anon + sessão do usuário), NUNCA service_role.
  // É a prova viva do RLS da Fase 1: a política de usuarios só devolve a própria
  // linha e o tenants(nome) embutido só resolve porque a política de tenants
  // libera apenas o próprio tenant. Se o RLS falhasse, aqui vazaria outro tenant.
  const { data, error } = await supabase
    .from('usuarios')
    .select('nome, tenants(nome)')
    .eq('id', user.id)
    .single()

  // Fail-closed: sem vínculo legível (órfão ou RLS negando), não renderiza dado.
  if (error || !data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
        <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
          <p className="text-sm text-neutral-600">
            Não foi possível carregar o seu escritório.
          </p>
          <LogoutButton />
        </div>
      </main>
    )
  }

  // O embed tenants pode vir como objeto ou array conforme a inferência do
  // client; normalizamos defensivamente.
  const nome = (data.nome as string | null) ?? 'Usuário'
  const tenantsField = data.tenants as
    | { nome: string | null }
    | { nome: string | null }[]
    | null
  const tenantNome =
    (Array.isArray(tenantsField) ? tenantsField[0]?.nome : tenantsField?.nome) ??
    'seu escritório'

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Bem-vindo, {nome} —{' '}
          <span className="text-[#FF5A1F]">{tenantNome}</span>
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          Seu painel aparecerá aqui quando as conversas do WhatsApp estiverem
          ativas.
        </p>
        <div className="mt-6">
          <LogoutButton />
        </div>
      </div>
    </main>
  )
}

// Botão Sair: form + Server Action (sem client component). Estilo neutro —
// logout é ação secundária; o acento laranja fica no nome do escritório.
function LogoutButton() {
  return (
    <form action={logout}>
      <button
        type="submit"
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF5A1F] focus-visible:ring-offset-2"
      >
        Sair
      </button>
    </form>
  )
}
