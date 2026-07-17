import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Renova a sessão (refresh de token) a cada navegação e aplica a proteção de
 * rotas por redirect. Segue o padrão oficial do @supabase/ssr para Next 15.
 *
 * ATENÇÃO — este é o ponto onde bug de sessão nasce. Duas regras invioláveis:
 *  1) NÃO colocar lógica entre createServerClient e getUser() (evita que o
 *     token não seja renovado e o usuário caia deslogado aleatoriamente).
 *  2) Preservar os cookies que o Supabase gravou: qualquer resposta retornada
 *     (inclusive redirect) tem que carregar esses cookies, senão a sessão some.
 *
 * NOTA DE SEGURANÇA: este middleware é CONVENIÊNCIA (redirect), não a fronteira
 * de segurança. A página /dashboard revalida getUser() por conta própria e o
 * RLS é a fronteira real dos dados. Já houve CVE de bypass de middleware.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Grava os cookies renovados tanto no request quanto na response.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // getUser() valida o token no servidor (getSession só lê o cookie, sem validar).
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const needsAuth = pathname.startsWith('/dashboard')
  const isAuthPage = pathname === '/login' || pathname === '/signup'

  // Sem sessão em rota protegida → login. Com sessão em página de auth → dashboard.
  if (!user && needsAuth) {
    return redirectPreservingCookies(request, supabaseResponse, '/login')
  }
  if (user && isAuthPage) {
    return redirectPreservingCookies(request, supabaseResponse, '/dashboard')
  }

  // Caminho normal: devolve a response COM os cookies renovados.
  return supabaseResponse
}

/**
 * Redireciona preservando os cookies de sessão já gravados na response original
 * — sem isso, um token recém-renovado se perderia no redirect.
 */
function redirectPreservingCookies(
  request: NextRequest,
  from: NextResponse,
  pathname: string,
) {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  const redirect = NextResponse.redirect(url)
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie))
  return redirect
}
