'use client'

import { useActionState } from 'react'
import { loginUser, type LoginState } from './actions'
import {
  errorBoxClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from '@/lib/ui/form'

const initialState: LoginState = { status: 'idle' }

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(loginUser, initialState)

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.status === 'error' && (
        <div role="alert" aria-live="polite" className={errorBoxClass}>
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

      <button type="submit" disabled={isPending} className={primaryButtonClass}>
        {isPending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  )
}
