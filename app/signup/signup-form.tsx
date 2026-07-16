'use client'

import { useActionState } from 'react'
import { signUpOwner, type SignUpState } from './actions'

const initialState: SignUpState = { status: 'idle' }

// Classes reaproveitadas nos inputs (evita repetição e mantém consistência).
const inputClass =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-neutral-900 ' +
  'outline-none focus:border-[#FF5A1F] focus:ring-2 focus:ring-[#FF5A1F]/30'
const labelClass = 'block text-sm font-medium text-neutral-700'

export function SignUpForm() {
  // useActionState liga o formulário à Server Action e expõe o estado que ela
  // retorna (erro/sucesso) + isPending para desabilitar o botão no envio.
  const [state, formAction, isPending] = useActionState(
    signUpOwner,
    initialState,
  )

  // No sucesso, trocamos o formulário pela confirmação (confirmação de e-mail
  // está ligada — não há login imediato).
  if (state.status === 'success') {
    return (
      <div
        role="alert"
        className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800"
      >
        {state.message}
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {/* Região de erro: role=alert + aria-live para leitores de tela anunciarem */}
      {state.status === 'error' && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {state.message}
        </div>
      )}

      <div>
        <label htmlFor="tenantName" className={labelClass}>
          Nome do escritório
        </label>
        <input
          id="tenantName"
          name="tenantName"
          type="text"
          autoComplete="organization"
          required
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="ownerName" className={labelClass}>
          Seu nome
        </label>
        <input
          id="ownerName"
          name="ownerName"
          type="text"
          autoComplete="name"
          required
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="email" className={labelClass}>
          E-mail
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="password" className={labelClass}>
          Senha
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className={inputClass}
        />
        <p className="mt-1 text-xs text-neutral-500">Mínimo de 8 caracteres.</p>
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-[#FF5A1F] px-4 py-2 font-medium text-white transition-colors hover:bg-[#e64e17] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF5A1F] focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {isPending ? 'Criando…' : 'Criar escritório'}
      </button>
    </form>
  )
}
