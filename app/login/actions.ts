'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export type LoginState =
  | { status: 'idle' }
  | { status: 'error'; message: string }

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Login do usuário (email+senha) via Supabase Auth, server-side.
 *
 * Mensagem de erro sempre GENÉRICA: não distinguimos "senha errada" de "e-mail
 * inexistente" nem "e-mail não confirmado" — isso vazaria a existência da conta
 * (anti-enumeração, mesma lógica do signup). A orientação sobre confirmar o
 * e-mail fica como texto estático na página, sem confirmar que a conta existe.
 */
export async function loginUser(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  // Validação mínima: sem formato de e-mail ou senha vazia, nem chamamos o Auth.
  if (!EMAIL_REGEX.test(email) || password.length === 0) {
    return { status: 'error', message: 'E-mail ou senha incorretos.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error || !data.user) {
    // Log mínimo, sem PII (A09): não registramos e-mail nem o motivo do Auth.
    console.warn('login falhou')
    return { status: 'error', message: 'E-mail ou senha incorretos.' }
  }

  // Log mínimo: só o id opaco do usuário, nunca e-mail/nome.
  console.log('login ok', { userId: data.user.id })

  // redirect() lança NEXT_REDIRECT — fica FORA de try/catch de propósito.
  // A sessão já foi gravada nos cookies pelo signInWithPassword.
  redirect('/dashboard')
}
