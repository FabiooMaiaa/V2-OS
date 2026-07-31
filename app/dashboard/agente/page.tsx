import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Shell, BackLink } from '@/lib/ui/shell'
import { inputClass, labelClass, primaryButtonClass } from '@/lib/ui/form'

export const metadata: Metadata = {
  title: 'Agente — V2 OS',
}

export default async function AgentePage() {
  const supabase = await createClient()

  // Defesa em profundidade: NÃO confiamos só no middleware (conveniência, já
  // teve CVE de bypass). A página revalida a sessão no servidor.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect('/login')
  }

  // O papel decide a UI (form editável vs. leitura). Vem do BANCO, nunca de
  // cookie/query/header — o cliente não escolhe o próprio papel.
  const { data: me } = await supabase
    .from('usuarios')
    .select('role')
    .eq('id', user.id)
    .single()

  // Leitura via SERVER CLIENT (anon + sessão), NUNCA service_role. Sem filtro de
  // tenant na query de propósito: quem filtra é o RLS (tenant_id =
  // current_tenant_id()). Owner e member leem — a política é tenant-wide.
  const { data: agente, error } = await supabase
    .from('agentes')
    .select('nome, system_prompt, updated_at')
    .single()

  // Fail-closed: sem papel legível ou sem agente, não renderiza nada editável.
  // (Todo tenant nasce com agente desde o Passo 2a; cair aqui indica RLS negando
  // ou vínculo quebrado, e nos dois casos o certo é não mostrar formulário.)
  if (!me || error || !agente) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold text-neutral-900">Agente</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Não foi possível carregar o agente do seu escritório.
        </p>
        <BackLink />
      </Shell>
    )
  }

  const isOwner = me.role === 'owner'
  const systemPrompt = (agente.system_prompt as string | null) ?? ''

  return (
    <Shell maxWidthClass="max-w-2xl">
      <h1 className="text-2xl font-semibold text-neutral-900">
        {(agente.nome as string | null) ?? 'Agente'}
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Estas instruções definem como o agente responde aos seus clientes no
        WhatsApp.
      </p>

      {isOwner ? (
        <OwnerView systemPrompt={systemPrompt} />
      ) : (
        <MemberView systemPrompt={systemPrompt} />
      )}

      <BackLink />
    </Shell>
  )
}

/**
 * OWNER: textarea editável. O botão salvar está DESABILITADO neste passo — a
 * Server Action de gravação chega no passo (c), e um botão que finge salvar é
 * pior que um botão honestamente inativo.
 *
 * ATENÇÃO: este form ser exibido só ao owner é CONVENIÊNCIA de UI, não controle
 * de acesso. A trava real é a revalidação de role='owner' no servidor, dentro da
 * ação de salvar (passo c) — nunca confiar em "escondi o botão".
 */
function OwnerView({ systemPrompt }: { systemPrompt: string }) {
  return (
    <div className="mt-6">
      <label htmlFor="system_prompt" className={labelClass}>
        Instruções do agente
      </label>
      <textarea
        id="system_prompt"
        name="system_prompt"
        rows={18}
        defaultValue={systemPrompt}
        className={`${inputClass} font-mono text-sm leading-relaxed`}
      />
      <p className="mt-2 text-xs text-neutral-500">
        {systemPrompt.length} caracteres
      </p>
      <button type="button" disabled className={`${primaryButtonClass} mt-4`}>
        Salvar
      </button>
      <p className="mt-2 text-center text-xs text-neutral-500">
        Salvar será habilitado no próximo passo.
      </p>
    </div>
  )
}

/**
 * MEMBER: mesmo conteúdo, modo leitura. Mostramos em vez de esconder porque o
 * RLS já dá SELECT tenant-wide em agentes — o member consegue ler o prompt de
 * qualquer forma. Esconder o link daria a impressão falsa de que é segredo, e
 * ver o prompt ajuda o funcionário a alinhar o atendimento humano com o do
 * agente. Sem textarea e sem botão: nada aqui sugere que ele pode editar.
 */
function MemberView({ systemPrompt }: { systemPrompt: string }) {
  return (
    <div className="mt-6">
      <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
        Apenas o dono do escritório pode editar as instruções do agente.
      </p>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-200 bg-white p-3 font-mono text-sm leading-relaxed text-neutral-800">
        {systemPrompt}
      </pre>
    </div>
  )
}
