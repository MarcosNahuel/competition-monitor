/**
 * Smart search query builder — ported from AGUS meli-monitor
 *
 * Builds an effective search query from product title + brand:
 * 1. Remove stopwords, colors, generic terms
 * 2. Keep model identifiers (alphanumeric tokens)
 * 3. Prepend brand
 * 4. Limit to 5 tokens
 */

const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'con', 'para', 'por',
  'en', 'es', 'al', 'se', 'que', 'no', 'si', 'su', 'mas', 'sin', 'muy',
  'y', 'o', 'e', 'a',
  // ML-specific
  'envio', 'envío', 'gratis', 'nuevo', 'nueva', 'garantia', 'garantía',
  'pack', 'oferta', 'kit', 'set', 'combo', 'promo', 'promocion',
  'original', 'generico', 'compatible', 'reemplazo',
  'unidad', 'unidades', 'pieza', 'piezas',
])

const COLORS = new Set([
  'negro', 'negra', 'blanco', 'blanca', 'rojo', 'roja', 'azul',
  'verde', 'amarillo', 'amarilla', 'gris', 'rosa', 'naranja',
  'violeta', 'celeste', 'marron', 'marrón', 'dorado', 'plateado',
  'beige', 'turquesa', 'bordo', 'burgundy', 'black', 'white',
  'red', 'blue', 'green', 'silver', 'gold', 'grey', 'gray',
])

/**
 * Build search query from title and brand
 */
export function buildSearchQuery(title: string, brand?: string): string {
  const tokens = title
    .toLowerCase()
    .replace(/[^\w\sáéíóúüñ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
    .filter(t => !STOPWORDS.has(t))
    .filter(t => !COLORS.has(t))
    .filter(t => !/^\d{1,2}$/.test(t)) // remove 1-2 digit numbers (sizes)

  // Prepend brand if not already in tokens
  const brandLower = brand?.toLowerCase().trim()
  if (brandLower && !tokens.includes(brandLower)) {
    tokens.unshift(brandLower)
  }

  // Prioritize model identifiers (mix of letters and numbers)
  const modelTokens = tokens.filter(t => /[a-z]/.test(t) && /\d/.test(t))
  const otherTokens = tokens.filter(t => !modelTokens.includes(t))
  const ordered = [...new Set([...tokens.slice(0, 1), ...modelTokens, ...otherTokens])]

  return ordered.slice(0, 5).join(' ')
}

/**
 * Compute match confidence between search result and our product
 * Returns 'high', 'medium', 'low', or 'none'
 */
export function computeMatchConfidence(
  resultTitle: string,
  resultBrand: string | undefined,
  ourTitle: string,
  ourBrand: string | undefined
): 'high' | 'medium' | 'low' | 'none' {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\sáéíóúüñ]/g, '').trim()

  const rTitle = normalize(resultTitle)
  const oTitle = normalize(ourTitle)
  const rBrand = resultBrand ? normalize(resultBrand) : ''
  const oBrand = ourBrand ? normalize(ourBrand) : ''

  // Brand match
  const brandMatch = oBrand && rBrand && (rBrand.includes(oBrand) || oBrand.includes(rBrand))
  if (!brandMatch && oBrand) return 'none'

  // Title token overlap
  const rTokens = new Set(rTitle.split(/\s+/).filter(t => t.length > 2))
  const oTokens = oTitle.split(/\s+/).filter(t => t.length > 2)
  const overlap = oTokens.filter(t => rTokens.has(t)).length

  if (overlap >= 3) return 'high'
  if (overlap >= 2) return 'medium'
  if (brandMatch) return 'low'
  return 'none'
}
