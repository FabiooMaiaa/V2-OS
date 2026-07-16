// 'server-only' é uma barreira de COMPILAÇÃO: se este módulo for importado por
// engano em qualquer código de cliente ('use client'), o build QUEBRA. É a
// garantia forte de que a service_role nunca chega ao bundle do browser.
import 'server-only'

import { createClient } from '@supabase/supabase-js'

/**
 * Cria um cliente Supabase ADMIN, autenticado com a service_role.
 *
 * A service_role IGNORA o RLS — é ela que provisiona tenant/usuario (escrita
 * deixada fail-closed na Fase 1). Por isso, uso EXCLUSIVAMENTE server-side,
 * dentro de Server Actions/Route Handlers. Jamais em Client Components.
 */
export function createAdminClient() {
  return createClient(
    // A URL é pública; ler a mesma NEXT_PUBLIC_ no servidor é ok.
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    // SEM prefixo NEXT_PUBLIC_ de propósito: o Next só injeta no bundle do
    // browser variáveis NEXT_PUBLIC_*. Sem o prefixo, esta chave fica
    // disponível apenas no servidor e nunca é embutida no JS do cliente.
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      // Client sem estado: não guarda nem renova sessão (é um cliente de
      // máquina, não de um usuário logado).
      auth: { autoRefreshToken: false, persistSession: false },
    },
  )
}
