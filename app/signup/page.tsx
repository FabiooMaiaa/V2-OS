import type { Metadata } from 'next'
import { SignUpForm } from './signup-form'

export const metadata: Metadata = {
  title: 'Criar conta — V2 OS',
  description: 'Crie o seu escritório no V2 OS.',
}

// Server Component: só estrutura/layout. A interatividade (estado da action,
// erros, sucesso) fica no SignUpForm, que é Client Component.
export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Criar seu escritório
        </h1>
        <p className="mt-1 mb-6 text-sm text-neutral-500">
          Cadastre-se como dono. Você poderá convidar sua equipe depois.
        </p>
        <SignUpForm />
      </div>
    </main>
  )
}
