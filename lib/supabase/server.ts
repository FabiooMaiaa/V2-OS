import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Cria um cliente Supabase para uso NO SERVIDOR (Server Components, Server
 * Actions, Route Handlers), operando como o USUÁRIO AUTENTICADO.
 *
 * Usa a chave anon (pública) + os cookies da requisição: assim o RLS enxerga
 * o auth.uid() do usuário logado e aplica o isolamento por tenant. NÃO tem
 * privilégio elevado — para escrever em tenants/usuarios (fail-closed) use o
 * admin client (service_role) em lib/supabase/admin.ts.
 */
export async function createClient() {
  // No Next 15, cookies() é assíncrono — daí a função ser async.
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Ponte de cookies: é por aqui que o @supabase/ssr lê a sessão da
      // requisição e grava os cookies renovados (refresh de token).
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // setAll chamado a partir de um Server Component (onde não se pode
            // gravar cookie). Seguro ignorar quando houver middleware
            // renovando a sessão — será tratado no bloco de login/rotas.
          }
        },
      },
    },
  )
}
