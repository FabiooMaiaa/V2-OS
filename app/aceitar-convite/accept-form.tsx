'use client'

import { useActionState } from 'react'
import { acceptInvite, type AcceptState } from './actions'
import {
  errorBoxClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  successBoxClass,
} from '@/lib/ui/form'

const initialState: AcceptState = { status: 'idle' }

// O e-mail é apenas EXIBIDO (read-only, sem `name`) — não é submetido nem usado
// pelo servidor, que deriva o e-mail do token. Só o token (hidden), nome e senha
// vão no submit.
export function AcceptForm({ token, email }: { token: string; email: string }) {
  const [state, formAction, isPending] = useActionState(
    acceptInvite,
    initialState,
  )

  if (state.status === 'success') {
    return (
      <div role="alert" className={successBoxClass}>
        {state.message}
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />

      {state.status === 'error' && (
        <div role="alert" aria-live="polite" className={errorBoxClass}>
          {state.message}
        </div>
      )}

      <div>
        <label htmlFor="email" className={labelClass}>
          E-mail do convite
        </label>
        {/* Sem `name`: exibição apenas; o servidor usa o e-mail do token. */}
        <input
          id="email"
          type="email"
          value={email}
          readOnly
          aria-readonly="true"
          className={`${inputClass} bg-neutral-100 text-neutral-500`}
        />
      </div>

      <div>
        <label htmlFor="nome" className={labelClass}>
          Seu nome
        </label>
        <input
          id="nome"
          name="nome"
          type="text"
          autoComplete="name"
          required
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="password" className={labelClass}>
          Crie uma senha
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

      <button type="submit" disabled={isPending} className={primaryButtonClass}>
        {isPending ? 'Aceitando…' : 'Aceitar convite'}
      </button>
    </form>
  )
}
