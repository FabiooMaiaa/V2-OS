'use client'

import { useActionState, useState } from 'react'
import { generateInvite, type InviteState } from './actions'
import {
  errorBoxClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from '@/lib/ui/form'

const initialState: InviteState = { status: 'idle' }

export function InviteForm() {
  const [state, formAction, isPending] = useActionState(
    generateInvite,
    initialState,
  )

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-4" noValidate>
        {state.status === 'error' && (
          <div role="alert" aria-live="polite" className={errorBoxClass}>
            {state.message}
          </div>
        )}

        <div>
          <label htmlFor="email" className={labelClass}>
            E-mail do funcionário
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="off"
            required
            className={inputClass}
          />
        </div>

        <button type="submit" disabled={isPending} className={primaryButtonClass}>
          {isPending ? 'Gerando…' : 'Gerar convite'}
        </button>
      </form>

      {state.status === 'success' && (
        <CopyLink link={state.link} message={state.message} />
      )}
    </div>
  )
}

// Mostra o link gerado num campo read-only com botão de copiar.
function CopyLink({ link, message }: { link: string; message: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard requer contexto seguro (https/localhost). Sem fallback ruidoso.
    }
  }

  return (
    <div
      role="status"
      className="rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800"
    >
      <p className="mb-2">{message}</p>
      <div className="flex gap-2">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-900"
        />
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md border border-[#FF5A1F] px-3 py-2 font-medium text-[#FF5A1F] transition-colors hover:bg-[#FF5A1F]/10"
        >
          {copied ? 'Copiado!' : 'Copiar'}
        </button>
      </div>
    </div>
  )
}
