'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { MAX_PROMPT_LENGTH } from './constants'

export type SaveAgenteState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; message: string }

const GENERIC_ERROR = 'Não foi possível salvar. Tente novamente em instantes.'

/**
 * Salva o system_prompt do agente do PRÓPRIO tenant. Só o owner.
 *
 * Usa o SERVER CLIENT (sessão do owner), NUNCA service_role: existe sessão aqui,
 * então quem decide é o RLS. A service_role fica reservada para escrita SEM
 * sessão (o webhook da Evolution).
 *
 * Camadas, da mais externa à mais interna — todas independentes:
 *   1) a UI só mostra o form ao owner (conveniência, não segurança);
 *   2) esta action revalida role='owner' (falha cedo, com mensagem clara);
 *   3) a política de UPDATE do RLS exige is_owner() + tenant próprio;
 *   4) o GRANT por coluna só permite tocar (nome, system_prompt).
 * Se a 2 for removida por um refactor, 3 e 4 seguem negando.
 */
export async function saveAgentePrompt(
  _prevState: SaveAgenteState,
  formData: FormData,
): Promise<SaveAgenteState> {
  // --- Validação do input ---
  // btrim antes de medir: um prompt só de espaços/quebras é tão inútil quanto um
  // vazio, e é o mesmo tratamento que o default da coluna recebe no banco.
  const systemPrompt = String(formData.get('system_prompt') ?? '').trim()

  if (!systemPrompt) {
    return {
      status: 'error',
      message: 'As instruções não podem ficar em branco.',
    }
  }
  if (systemPrompt.length > MAX_PROMPT_LENGTH) {
    return {
      status: 'error',
      message: `As instruções passam do limite de ${MAX_PROMPT_LENGTH.toLocaleString('pt-BR')} caracteres (você usou ${systemPrompt.length.toLocaleString('pt-BR')}).`,
    }
  }

  // NÃO sanitizamos/escapamos o texto: é instrução para o modelo, não HTML. O
  // React escapa na renderização, e escapar aqui corromperia o prompt.

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { status: 'error', message: GENERIC_ERROR }
  }

  // Papel vem do BANCO, nunca de cookie/query/header.
  const { data: me } = await supabase
    .from('usuarios')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!me || me.role !== 'owner') {
    return {
      status: 'error',
      message: 'Apenas o dono do escritório pode editar as instruções.',
    }
  }

  // Descobre o agente do tenant pelo RLS (sem filtro de tenant na query: quem
  // filtra é a política). Serve também para evitar um UPDATE sem WHERE.
  const { data: agente, error: findError } = await supabase
    .from('agentes')
    .select('id')
    .single()

  if (findError || !agente) {
    return { status: 'error', message: GENERIC_ERROR }
  }

  // updated_at NÃO é enviado: quem carimba é a trigger set_updated_at() — data
  // vinda do cliente é forjável.
  const { data: updated, error: updateError } = await supabase
    .from('agentes')
    .update({ system_prompt: systemPrompt })
    .eq('id', agente.id)
    .select('id')

  if (updateError) {
    console.warn('saveAgentePrompt: update negado', { userId: user.id })
    return { status: 'error', message: GENERIC_ERROR }
  }

  // CRÍTICO: um UPDATE barrado pelo USING do RLS NÃO devolve erro — ele apenas
  // não casa nenhuma linha. Sem esta checagem, uma escrita negada pelo banco
  // reportaria "salvo com sucesso" e o usuário acreditaria ter salvado.
  // Fail-closed: 0 linhas = negado.
  if (!updated || updated.length === 0) {
    console.warn('saveAgentePrompt: 0 linhas afetadas', { userId: user.id })
    return { status: 'error', message: GENERIC_ERROR }
  }

  // Recarrega o server component para refletir o texto salvo e o novo updated_at.
  revalidatePath('/dashboard/agente')

  return { status: 'success', message: 'Instruções salvas.' }
}
