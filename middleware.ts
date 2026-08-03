import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

// Delegamos ao helper para manter o arquivo raiz enxuto e o padrão testável.
export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  // Roda em todas as rotas de PÁGINA (para renovar a sessão), mas exclui os
  // assets internos do Next e imagens estáticas — validar sessão a cada arquivo
  // estático seria custo sem ganho de segurança.
  //
  // `api/` também fica FORA: um webhook não tem sessão, então updateSession()
  // só gastaria uma ida à rede ao Supabase Auth (getUser) por mensagem
  // recebida, sem nenhum ganho. Rota de API que precise de sessão deve chamar
  // getUser() por conta própria — o middleware sempre foi conveniência, nunca a
  // fronteira de segurança (ver nota em lib/supabase/middleware.ts).
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
