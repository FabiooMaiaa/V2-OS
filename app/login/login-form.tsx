'use client'

import { useActionState } from 'react'
import { loginUser, type LoginState } from './actions'

const initialState: LoginState = { status: 'idle' }

// Classes duplicadas do signup de propósito: com só 2 usos ainda não se sabe
// qual é o padrão real. Refatoramos para um util compartilhado no 3º form.
const inputClass =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-neutral-900 ' +
  'outline-none focus:border-[#FF5A1F] focus:ring-2 focus:ring-[#FF5A1F]/30'
const labelClass = 'block text-sm font-medium text-neutral-700'

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(loginUser, initialState)

  return (
    <form action={formAction} className="space-y-4" noValidate>
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
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-[#FF5A1F] px-4 py-2 font-medium text-white transition-colors hover:bg-[#e64e17] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF5A1F] focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {isPending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  )
}
