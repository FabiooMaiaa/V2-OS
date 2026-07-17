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
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
