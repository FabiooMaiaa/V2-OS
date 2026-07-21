import type { Metadata } from 'next'
import { createAdminClient } from '@/lib/supabase/admin'
import { AcceptForm } from './accept-form'

export const metadata: Metadata = {
  title: 'Aceitar convite — V2 OS',
}

// Página PÚBLICA (o convidado não está logado). O middleware já a libera por
// não estar sob /dashboard.
export default async function AceitarConvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return <Invalid />
  }

  // Preview read-only via service_role (o convidado não tem linha em usuarios,
  // então não pode ler convites por RLS). 0 linhas = token inválido/expirado/usado.
  const admin = createAdminClient()
  const { data, error } = await admin.rpc('get_invite_preview', {
    p_token: token,
  })
  const preview = Array.isArray(data) ? data[0] : data

  if (error || !preview) {
    return <Invalid />
  }

  return (
    <Shell>
      <h1 className="text-2xl font-semibold text-neutral-900">
        Convite para{' '}
        <span className="text-[#FF5A1F]">{preview.tenant_nome}</span>
      </h1>
      <p className="mt-1 mb-6 text-sm text-neutral-500">
        Crie sua conta para entrar na equipe.
      </p>
      <AcceptForm token={token} email={preview.email as string} />
    </Shell>
  )
}

// Mensagem NEUTRA: não revela se o token não existe, expirou ou já foi usado.
function Invalid() {
  return (
    <Shell>
      <h1 className="text-2xl font-semibold text-neutral-900">
        Convite inválido
      </h1>
      <p className="mt-2 text-sm text-neutral-600">
        Este convite é inválido ou expirou. Peça um novo link ao dono do
        escritório.
      </p>
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
