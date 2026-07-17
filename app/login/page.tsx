import type { Metadata } from 'next'
import Link from 'next/link'
import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: 'Entrar — V2 OS',
  description: 'Acesse o seu escritório no V2 OS.',
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-neutral-900">Entrar</h1>
        <p className="mt-1 mb-6 text-sm text-neutral-500">
          Acesse o seu escritório.
        </p>

        <LoginForm />

        {/* Ajuda estática sobre confirmação de e-mail: orienta o usuário
            legítimo SEM confirmar, na falha de login, que a conta existe. */}
        <p className="mt-4 text-xs text-neutral-500">
          Acabou de se cadastrar? Confirme seu e-mail pelo link que enviamos
          (verifique também o spam) antes de entrar.
        </p>

        <p className="mt-6 text-sm text-neutral-600">
          Ainda não tem conta?{' '}
          <Link href="/signup" className="font-medium text-[#FF5A1F] hover:underline">
            Criar escritório
          </Link>
        </p>
      </div>
    </main>
  )
}
