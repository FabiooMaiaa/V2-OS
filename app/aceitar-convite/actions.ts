'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export type AcceptState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; message: string }

const MIN_PASSWORD_LENGTH = 8
// Mensagem neutra: não revela SE o token existe, expirou ou já foi usado (A10).
const GENERIC_ERROR =
  'Não foi possível aceitar o convite. O link pode ser inválido ou ter expirado.'

/**
 * Aceite de convite pelo funcionário (padrão saga, como AUTH.1).
 *
 * SEGURANÇA: o e-mail NÃO vem do formulário — é derivado do TOKEN no servidor
 * (get_invite_preview). Assim o convidado não consegue trocar o e-mail (nem
 * editando o DOM). tenant_id e role vêm do token dentro do accept_invite.
 */
export async function acceptInvite(
  _prevState: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const token = String(formData.get('token') ?? '')
  const nome = String(formData.get('nome') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!token) {
    return { status: 'error', message: GENERIC_ERROR }
  }
  if (!nome) {
    return { status: 'error', message: 'Informe o seu nome.' }
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      status: 'error',
      message: `A senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    }
  }

  const admin = createAdminClient()

  // Deriva o e-mail do TOKEN (server-side). Também barra token inválido/expirado/
  // usado ANTES de criar qualquer conta. O accept_invite ainda revalida de forma
  // atômica (defende contra corrida entre este preview e o aceite).
  const { data: previewData, error: previewError } = await admin.rpc(
    'get_invite_preview',
    { p_token: token },
  )
  const preview = Array.isArray(previewData) ? previewData[0] : previewData
  if (previewError || !preview) {
    return { status: 'error', message: GENERIC_ERROR }
  }
  const email = preview.email as string

  // Cria a conta (Supabase Auth; confirmação de e-mail LIGADA; nunca auth própria).
  const supabase = await createClient()
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
  })
  if (signUpError || !signUpData.user) {
    return { status: 'error', message: GENERIC_ERROR }
  }
  // E-mail já tem conta (identities vazio): no schema atual um usuário pertence
  // a um único tenant, então não dá para aceitar com um e-mail já cadastrado.
  if ((signUpData.user.identities ?? []).length === 0) {
    return {
      status: 'error',
      message: 'Este e-mail já possui uma conta. Faça login para continuar.',
    }
  }
  const userId = signUpData.user.id

  // Claim atômico + criação do usuario com tenant_id e role DO TOKEN.
  const { error: acceptError } = await admin.rpc('accept_invite', {
    p_token: token,
    p_user_id: userId,
    p_nome: nome,
    p_email: email,
  })

  // Compensação da saga: sem o vínculo, desfaz o auth user recém-criado.
  if (acceptError) {
    try {
      await admin.auth.admin.deleteUser(userId)
    } catch {
      console.error('acceptInvite: falha na compensação, auth user órfão', {
        userId,
      })
    }
    return { status: 'error', message: GENERIC_ERROR }
  }

  return {
    status: 'success',
    message:
      'Convite aceito! Enviamos um link de confirmação para o seu e-mail. Confirme para entrar.',
  }
}
