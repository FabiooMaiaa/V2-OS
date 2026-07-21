'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export type InviteState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; message: string; link: string }

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const GENERIC_ERROR = 'Não foi possível gerar o convite. Tente novamente.'

/**
 * Gera um convite (só o OWNER pode). O ownerId vem do getUser() SERVER-SIDE —
 * nunca do cliente. A RPC create_invite deriva o tenant do próprio owner e
 * valida o papel; então mesmo que um member chame esta action, a RPC nega
 * (defesa em profundidade além da checagem de página).
 */
export async function generateInvite(
  _prevState: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const email = String(formData.get('email') ?? '').trim()
  if (!EMAIL_REGEX.test(email)) {
    return { status: 'error', message: 'Informe um e-mail válido.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { status: 'error', message: GENERIC_ERROR }
  }

  // service_role só aqui, server-side. A RPC valida owner + deriva o tenant.
  const admin = createAdminClient()
  const { data: token, error } = await admin.rpc('create_invite', {
    p_owner_id: user.id,
    p_email: email,
  })

  if (error || !token) {
    // Inclui o caso "não é owner" (a RPC dá raise). Log sem PII (A09): só o id.
    console.warn('generateInvite: falha', { ownerId: user.id })
    return { status: 'error', message: GENERIC_ERROR }
  }

  const link = `${await getBaseUrl()}/aceitar-convite?token=${token}`
  return {
    status: 'success',
    message: 'Convite gerado. Copie o link e envie ao funcionário.',
    link,
  }
}

/**
 * Base absoluta para montar o link do convite: prioriza NEXT_PUBLIC_SITE_URL;
 * na ausência, cai no origin do request (host + protocolo dos headers).
 */
async function getBaseUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) return configured.replace(/\/$/, '')

  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? 'https'
  return `${proto}://${host}`
}
