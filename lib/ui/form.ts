// Classes de formulário compartilhadas. Extraídas no 3º uso (signup, login,
// convite) — antes disso não dava para saber qual era o padrão real.
// São só strings de Tailwind; podem ser importadas por client e server.

export const inputClass =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-neutral-900 ' +
  'outline-none focus:border-[#FF5A1F] focus:ring-2 focus:ring-[#FF5A1F]/30'

export const labelClass = 'block text-sm font-medium text-neutral-700'

export const primaryButtonClass =
  'w-full rounded-md bg-[#FF5A1F] px-4 py-2 font-medium text-white transition-colors ' +
  'hover:bg-[#e64e17] focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-[#FF5A1F] focus-visible:ring-offset-2 disabled:opacity-60'

export const errorBoxClass =
  'rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700'

export const successBoxClass =
  'rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800'
