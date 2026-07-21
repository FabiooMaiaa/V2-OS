import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { InviteForm } from './invite-form'

export const metadata: Metadata = {
  title: 'Convidar funcionário — V2 OS',
}

export default async function ConvidarPage() {
  const supabase = await createClient()

  // Defesa em profundidade: revalida a sessão server-side.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // OWNER-ONLY: revalida o papel no servidor (o middleware só garante login,
  // não papel). Um member logado NÃO acessa esta página.
  const { data: me } = await supabase
    .from('usuarios')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!me || me.role !== 'owner') {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold text-neutral-900">Sem permissão</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Apenas o dono do escritório pode convidar funcionários.
        </p>
        <BackLink />
      </Shell>
    )
  }

  // Lista os convites pendentes. O RLS já restringe ao próprio tenant e ao
  // owner; NÃO selecionamos o token (segredo) — o link é entregue na geração.
  const { data: convites } = await supabase
    .from('convites')
    .select('email, expires_at, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  const pendentes = convites ?? []

  return (
    <Shell>
      <h1 className="text-2xl font-semibold text-neutral-900">
        Convidar funcionário
      </h1>
      <p className="mt-1 mb-6 text-sm text-neutral-500">
        Gere um link de convite e envie ao funcionário. Só o e-mail convidado
        poderá aceitar.
      </p>

      <InviteForm />

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-neutral-700">
          Convites pendentes
        </h2>
        {pendentes.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">Nenhum convite pendente.</p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
            {pendentes.map((c) => (
              <li
                key={c.email}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <span className="text-neutral-800">{c.email}</span>
                <span className="text-xs text-neutral-500">
                  expira {new Date(c.expires_at as string).toLocaleDateString('pt-BR')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BackLink />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        {children}
      </div>
    </main>
  )
}

function BackLink() {
  return (
    <p className="mt-6 text-sm">
      <Link href="/dashboard" className="font-medium text-[#FF5A1F] hover:underline">
        ← Voltar ao painel
      </Link>
    </p>
  )
}
