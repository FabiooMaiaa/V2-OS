'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/**
 * Logout: encerra a sessão no Supabase (limpa os cookies de auth) e manda para
 * /login. Server Action porque precisa gravar cookies (o server client faz isso
 * via setAll numa action). redirect() fica fora de try/catch (lança NEXT_REDIRECT).
 */
export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
