/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    tailwindcss: {},
    // autoprefixer: prefixos vendor para navegadores antigos. O público-alvo
    // (escritórios de contabilidade) costuma ter máquinas desatualizadas.
    autoprefixer: {},
  },
};

export default config;
