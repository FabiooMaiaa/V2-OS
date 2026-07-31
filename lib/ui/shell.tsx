// Casca visual das páginas internas (card centrado sobre fundo neutro) e o link
// de volta ao painel. Extraídos de app/dashboard/convidar/page.tsx no 2º uso
// (a tela do agente): o markup era idêntico, e uma 2ª cópia já divergiria.
import type { ReactNode } from 'react'
import Link from 'next/link'

/**
 * maxWidthClass: telas de formulário curto usam o padrão `max-w-md`; a do agente
 * precisa de mais largura porque o system_prompt é um texto longo, ilegível
 * numa coluna estreita.
 */
export function Shell({
  children,
  maxWidthClass = 'max-w-md',
}: {
  children: ReactNode
  maxWidthClass?: string
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div
        className={`w-full ${maxWidthClass} rounded-xl border border-neutral-200 bg-white p-8 shadow-sm`}
      >
        {children}
      </div>
    </main>
  )
}

export function BackLink() {
  return (
    <p className="mt-6 text-sm">
      <Link href="/dashboard" className="font-medium text-[#FF5A1F] hover:underline">
        ← Voltar ao painel
      </Link>
    </p>
  )
}
