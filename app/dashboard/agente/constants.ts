// Regras do agente compartilhadas entre a Server Action e o form.
//
// Mora em arquivo separado porque um módulo 'use server' só pode exportar
// funções async — constante exportada de lá quebra o build. E o form é client
// component, então importar da action arrastaria o módulo de servidor.

/**
 * Teto de tamanho do system_prompt. O default de fábrica tem ~1.400 chars, então
 * 8.000 é folgado para um escritório detalhar o atendimento — mas impede colar
 * um livro, o que encareceria TODA chamada ao Claude (o system_prompt vai em
 * toda requisição) e incharia o storage.
 *
 * Fonte única: a action valida por este número (a validação que vale) e o form
 * mostra o mesmo no contador (ajuda visual).
 */
export const MAX_PROMPT_LENGTH = 8000
