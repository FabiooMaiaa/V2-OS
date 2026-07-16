'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Estado retornado à UI (o formulário virá no próximo passo). Discriminado
// para a página saber renderizar erro vs. sucesso.
export type SignUpState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; message: string }

// Mensagem genérica ao usuário para falhas inesperadas: nunca expomos
// stack/detalhe de banco/mensagem interna (A10 — fail-closed; A09 — não vazar).
const GENERIC_ERROR =
  'Não foi possível concluir o cadastro. Tente novamente em instantes.'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8

/**
 * Signup do DONO: cria a conta (Supabase Auth) e provisiona o escritório
 * (tenant) + o vínculo owner, de forma atômica no banco.
 *
 * Ordem das operações é deliberada (padrão saga):
 *   1) valida input (nada de chamada externa se o input for inválido);
 *   2) auth.signUp cria o auth.users (e dispara o e-mail de confirmação);
 *   3) só com um user.id válido, a RPC cria tenant+usuario numa transação;
 *   4) se a RPC falhar, COMPENSA apagando o auth.users recém-criado.
 * Assim nunca sobra tenant sem dono, nem dono sem tenant. O auth user órfão
 * (sistemas separados: Auth ≠ Postgres) é resolvido pela compensação.
 */
export async function signUpOwner(
  _prevState: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  // --- 1) Validação manual (sem zod) ---
  const tenantName = String(formData.get('tenantName') ?? '').trim()
  const ownerName = String(formData.get('ownerName') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!tenantName) {
    return { status: 'error', message: 'Informe o nome do escritório.' }
  }
  if (!ownerName) {
    return { status: 'error', message: 'Informe o seu nome.' }
  }
  if (!EMAIL_REGEX.test(email)) {
    return { status: 'error', message: 'Informe um e-mail válido.' }
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      status: 'error',
      message: `A senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    }
  }

  // --- 2) Cria a conta via Supabase Auth (nunca auth própria — A07) ---
  // Client anon: a senha vai direto para o Supabase, que faz o hash (A04).
  const supabase = await createClient()
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
  })

  if (signUpError || !signUpData.user) {
    // Não repassamos a mensagem crua do Auth (pode conter detalhe interno).
    return { status: 'error', message: GENERIC_ERROR }
  }

  // Anti-enumeração do Supabase: se o e-mail já existe, signUp devolve um
  // "usuário" com identities vazio (sem erro). Tratamos como já cadastrado,
  // com mensagem neutra (não confirmamos existência de conta de terceiros).
  if ((signUpData.user.identities ?? []).length === 0) {
    return {
      status: 'error',
      message:
        'Se este e-mail estiver disponível, você receberá um link de confirmação.',
    }
  }

  const userId = signUpData.user.id

  // --- 3) Provisiona tenant + owner (service_role, ignora o RLS) ---
  // role NÃO vem do input: é fixado como 'owner' dentro da RPC — o usuário não
  // consegue pedir um papel privilegiado. A RPC roda tenant+usuario numa só
  // transação (atomicidade garantida no banco).
  const admin = createAdminClient()
  const { error: rpcError } = await admin.rpc('create_tenant_and_owner', {
    p_user_id: userId,
    p_tenant_nome: tenantName,
    p_nome: ownerName,
    p_email: email,
  })

  // --- 4) Compensação da saga: desfaz o auth user se o provisionamento falhou ---
  if (rpcError) {
    try {
      // Sem o tenant, este auth user ficaria órfão (o RLS fail-closed o faria
      // ver zero, mas não queremos lixo). Apagamos para manter a consistência.
      await admin.auth.admin.deleteUser(userId)
    } catch {
      // Se ATÉ a compensação falhar, logamos para limpeza manual — sem PII:
      // só o id opaco, nunca e-mail/nome/senha/service_role (A09).
      console.error('signup: falha na compensação, auth user órfão', { userId })
    }
    return { status: 'error', message: GENERIC_ERROR }
  }

  // Confirmação de e-mail LIGADA: não há sessão ainda; o dono confirma o
  // e-mail antes do primeiro login.
  return {
    status: 'success',
    message:
      'Cadastro criado! Enviamos um link de confirmação para o seu e-mail.',
  }
}
