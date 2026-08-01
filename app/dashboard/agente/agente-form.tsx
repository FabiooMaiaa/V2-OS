'use client'

import { useActionState, useState } from 'react'
import { saveAgentePrompt, type SaveAgenteState } from './actions'
import { MAX_PROMPT_LENGTH } from './constants'
import {
  errorBoxClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  successBoxClass,
} from '@/lib/ui/form'

const initialState: SaveAgenteState = { status: 'idle' }

/**
 * Form de edição do system_prompt (só o owner recebe este componente).
 *
 * O contador de caracteres e o `disabled` do botão são AJUDA VISUAL: a validação
 * que vale é a da Server Action, porque o cliente pode ser contornado. Por isso
 * o limite vem importado da action — um número só, sem regra duplicada.
 */
export function AgenteForm({ systemPrompt }: { systemPrompt: string }) {
  const [state, formAction, isPending] = useActionState(
    saveAgentePrompt,
    initialState,
  )
  const [length, setLength] = useState(systemPrompt.length)

  const vazio = length === 0
  const excedeu = length > MAX_PROMPT_LENGTH

  return (
    <form action={formAction} className="mt-6 space-y-4" noValidate>
      {state.status === 'error' && (
        <div role="alert" aria-live="polite" className={errorBoxClass}>
          {state.message}
        </div>
      )}
      {state.status === 'success' && (
        <div role="status" aria-live="polite" className={successBoxClass}>
          {state.message}
        </div>
      )}

      <div>
        <label htmlFor="system_prompt" className={labelClass}>
          Instruções do agente
        </label>
        <textarea
          id="system_prompt"
          name="system_prompt"
          rows={18}
          defaultValue={systemPrompt}
          onChange={(e) => setLength(e.currentTarget.value.trim().length)}
          className={`${inputClass} font-mono text-sm leading-relaxed`}
        />
        <p
          className={`mt-2 text-xs ${excedeu ? 'font-medium text-red-600' : 'text-neutral-500'}`}
        >
          {length.toLocaleString('pt-BR')} /{' '}
          {MAX_PROMPT_LENGTH.toLocaleString('pt-BR')} caracteres
          {excedeu && ' — passou do limite'}
        </p>
      </div>

      <button
        type="submit"
        disabled={isPending || vazio || excedeu}
        className={primaryButtonClass}
      >
        {isPending ? 'Salvando…' : 'Salvar'}
      </button>
    </form>
  )
}
