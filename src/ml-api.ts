/**
 * MercadoLibre API client — Search + Catalog + Seller profile
 */

import axios from 'axios'

const BASE = 'https://api.mercadolibre.com'

export interface CompetitorOffer {
  seller_id: string
  seller_name: string
  item_id: string
  price: number
  original_price: number | null
  logistic_type: string | null
  available_quantity: number | null
  sold_quantity: number | null
  permalink: string | null
  catalog_listing: boolean
  source: 'catalog' | 'search'
}

export interface SellerProfile {
  id: number
  nickname: string
  seller_reputation: {
    level_id: string
    power_seller_status: string | null
    transactions: { total?: number; completed?: number; canceled?: number }
    ratings?: { positive: number; negative: number; neutral: number }
  } | null
}

// ─── Token refresh ──────────────────────────────────────────────────────────

export async function getAccessToken(supabase: any, channelId: string): Promise<string | null> {
  const { data: cred } = await supabase
    .from('channel_credentials')
    .select('access_token, refresh_token, client_id, client_secret, expires_at')
    .eq('channel_id', channelId)
    .limit(1)
    .single()

  if (!cred) return null

  // Check if token needs refresh (5 min buffer)
  const expiresAt = new Date(cred.expires_at).getTime()
  if (Date.now() < expiresAt - 300000) {
    return cred.access_token
  }

  // Refresh
  try {
    const res = await axios.post(`${BASE}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: cred.refresh_token,
    })

    const newToken = res.data.access_token
    const newRefresh = res.data.refresh_token
    const newExpires = new Date(Date.now() + res.data.expires_in * 1000).toISOString()

    await supabase
      .from('channel_credentials')
      .update({ access_token: newToken, refresh_token: newRefresh, expires_at: newExpires })
      .eq('channel_id', channelId)

    return newToken
  } catch (e) {
    console.error('[ml-api] Token refresh failed:', e)
    return cred.access_token // Return old token, might still work
  }
}

// ─── Catalog API (products/{id}/items) ──────────────────────────────────────

export async function fetchCatalogCompetitors(
  catalogProductId: string,
  token: string
): Promise<CompetitorOffer[]> {
  try {
    const { data } = await axios.get(`${BASE}/products/${catalogProductId}/items`, {
      params: { status: 'active', limit: 50 },
      headers: { Authorization: `Bearer ${token}` },
    })

    return (data.results ?? []).map((r: any) => ({
      seller_id: String(r.seller_id ?? r.seller?.id ?? 0),
      seller_name: r.seller?.nickname ?? `Seller ${r.seller_id}`,
      item_id: r.item_id,
      price: r.price,
      original_price: r.original_price ?? null,
      logistic_type: r.shipping?.logistic_type ?? null,
      available_quantity: r.available_quantity ?? null,
      sold_quantity: r.sold_quantity ?? null,
      permalink: r.permalink ?? null,
      catalog_listing: r.catalog_listing ?? true,
      source: 'catalog' as const,
    }))
  } catch {
    return []
  }
}

// ─── Search API (/sites/MLA/search) ─────────────────────────────────────────

export async function searchByKeywords(
  query: string,
  limit: number = 50
): Promise<CompetitorOffer[]> {
  try {
    // Search API works WITHOUT token from cloud IPs
    const { data } = await axios.get(`${BASE}/sites/MLA/search`, {
      params: { q: query, limit },
    })

    return (data.results ?? []).map((r: any) => ({
      seller_id: String(r.seller?.id ?? 0),
      seller_name: r.seller?.nickname ?? 'Desconocido',
      item_id: r.id,
      price: r.price,
      original_price: r.original_price ?? null,
      logistic_type: r.shipping?.logistic_type ?? null,
      available_quantity: r.available_quantity ?? null,
      sold_quantity: r.sold_quantity ?? null,
      permalink: r.permalink ?? null,
      catalog_listing: r.catalog_listing ?? false,
      source: 'search' as const,
    }))
  } catch (e: any) {
    console.error(`[ml-api] Search failed for "${query}":`, e?.response?.status ?? e.message)
    return []
  }
}

export async function searchByCatalogId(
  catalogProductId: string
): Promise<CompetitorOffer[]> {
  try {
    const { data } = await axios.get(`${BASE}/sites/MLA/search`, {
      params: { catalog_product_id: catalogProductId, limit: 50 },
    })

    return (data.results ?? []).map((r: any) => ({
      seller_id: String(r.seller?.id ?? 0),
      seller_name: r.seller?.nickname ?? 'Desconocido',
      item_id: r.id,
      price: r.price,
      original_price: r.original_price ?? null,
      logistic_type: r.shipping?.logistic_type ?? null,
      available_quantity: r.available_quantity ?? null,
      sold_quantity: r.sold_quantity ?? null,
      permalink: r.permalink ?? null,
      catalog_listing: r.catalog_listing ?? false,
      source: 'search' as const,
    }))
  } catch {
    return []
  }
}

// ─── Items batch (multiget) ─────────────────────────────────────────────────

export async function fetchItemsBatch(
  itemIds: string[],
  token: string
): Promise<Array<{ code: number; body: any }>> {
  const results: Array<{ code: number; body: any }> = []
  const BATCH = 20

  for (let i = 0; i < itemIds.length; i += BATCH) {
    const ids = itemIds.slice(i, i + BATCH).join(',')
    try {
      const { data } = await axios.get(`${BASE}/items`, {
        params: { ids, attributes: 'id,price,catalog_product_id,permalink,available_quantity,sold_quantity,title,catalog_listing' },
        headers: { Authorization: `Bearer ${token}` },
      })
      results.push(...data)
    } catch { /* continue */ }

    if (i + BATCH < itemIds.length) await sleep(300)
  }
  return results
}

// ─── Seller profile ─────────────────────────────────────────────────────────

export async function fetchSellerProfile(
  sellerId: string,
  token: string
): Promise<SellerProfile | null> {
  try {
    const { data } = await axios.get(`${BASE}/users/${sellerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return data
  } catch {
    return null
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
