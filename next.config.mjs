/** @type {import('next').NextConfig} */

// OWASP A02 (Security Misconfiguration): baseline de headers de segurança
// aplicado a todas as rotas. Cada header fecha uma classe de ataque conhecida.
const securityHeaders = [
  // Impede que o app seja embutido em <iframe> de terceiros (clickjacking).
  { key: 'X-Frame-Options', value: 'DENY' },
  // Impede o browser de "adivinhar" o tipo do conteúdo (MIME sniffing).
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Não vaza a URL interna completa como Referer para sites externos.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Desliga APIs sensíveis do browser que o app não usa.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
