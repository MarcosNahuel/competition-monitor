/**
 * Competition Scanner — core logic
 *
 * For each product:
 * 1. If has catalog_product_id → try Catalog API first
 * 2. If no catalog or 0 competitors → fallback to Search API by keywords
 * 3. Filter self, calculate price diff, upsert to competition_map
 */

import { createClient } from '@supabase/supabase-js'
import type { TenantConfig } from './config.js'
import {
  getAccessToken,
  fetchCatalogCompetitors,
  fetchItemsBatch,
  fetchSellerProfile,
  type CompetitorOffer,
  type SellerProfile,
} from './ml-api.js'
import { buildSearchQuery, computeMatchConfidence } from './query-builder.js'

export interface ScanResult {
  tenant: string
  items_scanned: number
  catalog_found: number
  catalog_api_hits: number
  playwright_hits: number
  self_filtered: number
  sellers_new: number
  sellers_updated: number
  products_mapped: number
  winners_marked: number
  errors: number
  duration_ms: number
}

const MAX_CATALOG_PER_SCAN = 150
const MAX_SEARCH_PER_SCAN = 200
const MAX_SELLER_ENRICHMENTS = 30

export async function runScan(tenant: TenantConfig): Promise<ScanResult> {
  const start = Date.now()
  const sb = createClient(tenant.supabase_url, tenant.supabase_key)
  const selfSellerId = tenant.ml_seller_id.trim()

  console.log(`[scan:${tenant.name}] Starting...`)

  // Get ML token — debug: test direct query first
  const { data: directCred, error: directErr } = await sb
    .from('channel_credentials')
    .select('access_token')
    .eq('channel_id', tenant.channel_id)
    .limit(1)
    .maybeSingle()

  console.log(`[scan:${tenant.name}] Direct token query: found=${!!directCred?.access_token}, error=${directErr?.message ?? 'none'}`)

  const token = directCred?.access_token ?? await getAccessToken(sb, tenant.channel_id)
  if (!token) throw new Error('ML token not available')

  // 1. Read active listings
  const { data: listings, error } = await sb
    .from('product_listings')
    .select('id, product_id, external_item_id, title, price, catalog_product_id, logistic_type')
    .eq('channel_id', tenant.channel_id)
    .eq('status', 'active')
    .gt('price', 0)
    .order('price', { ascending: false })

  if (error || !listings?.length) {
    console.error(`[scan:${tenant.name}] No listings:`, error?.message)
    return emptyResult(tenant.name, start)
  }

  console.log(`[scan:${tenant.name}] ${listings.length} active listings`)

  // 2. Fetch catalog_product_id for items without it
  const needsCatalog = listings.filter((l: any) => !l.catalog_product_id && l.external_item_id)
  let catalogFound = listings.filter((l: any) => l.catalog_product_id).length

  if (needsCatalog.length > 0) {
    console.log(`[scan:${tenant.name}] Fetching catalog IDs for ${needsCatalog.length} items...`)
    const batch = await fetchItemsBatch(needsCatalog.map((l: any) => l.external_item_id), token)

    for (const result of batch) {
      if (result.code !== 200 || !result.body.catalog_product_id) continue
      const listing = needsCatalog.find((l: any) => l.external_item_id === result.body.id)
      if (!listing) continue

      await sb.from('product_listings')
        .update({ catalog_product_id: result.body.catalog_product_id })
        .eq('id', (listing as any).id)
      ;(listing as any).catalog_product_id = result.body.catalog_product_id
      catalogFound++
    }
    console.log(`[scan:${tenant.name}] Catalog IDs: ${catalogFound} total`)
  }

  // 3. Build product map
  const ourItemIds = new Set(listings.map((l: any) => l.external_item_id).filter(Boolean))
  const allCompetitors = new Map<string, { extItemId: string; offers: CompetitorOffer[] }>()

  // 3a. Catalog API for products with catalog_product_id
  const withCatalog = listings.filter((l: any) => l.catalog_product_id)
  const catalogMap = new Map<string, { extItemId: string; price: number; title: string }>()
  for (const l of withCatalog as any[]) {
    const existing = catalogMap.get(l.catalog_product_id)
    if (!existing || l.price > existing.price) {
      catalogMap.set(l.catalog_product_id, { extItemId: l.external_item_id, price: Number(l.price), title: l.title ?? '' })
    }
  }

  const catalogIds = Array.from(catalogMap.entries())
    .sort((a, b) => b[1].price - a[1].price)
    .slice(0, MAX_CATALOG_PER_SCAN)

  let catalogApiHits = 0
  let playwrightHits = 0
  let selfFiltered = 0
  let errorCount = 0

  console.log(`[scan:${tenant.name}] Catalog API: checking ${catalogIds.length} products...`)

  for (let i = 0; i < catalogIds.length; i += 5) {
    const batch = catalogIds.slice(i, i + 5)
    const results = await Promise.allSettled(
      batch.map(async ([catId]) => {
        const offers = await fetchCatalogCompetitors(catId, token)
        return { catId, offers }
      })
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') { errorCount++; continue }
      const { catId, offers } = r.value
      const product = catalogMap.get(catId)!
      const filtered = offers.filter(o => {
        if (String(o.seller_id).trim() === selfSellerId || ourItemIds.has(o.item_id)) {
          selfFiltered++
          return false
        }
        return true
      })

      if (filtered.length > 0) {
        catalogApiHits += filtered.length
        allCompetitors.set(product.extItemId, { extItemId: product.extItemId, offers: filtered })
      }
    }

    if (i + 5 < catalogIds.length) await sleep(300)
  }

  console.log(`[scan:${tenant.name}] Catalog API: ${catalogApiHits} competitors found`)

  // 3b. Playwright fallback for products WITHOUT competitors yet
  const needsScrape = listings
    .filter((l: any) => !allCompetitors.has(l.external_item_id) && l.title)
    .slice(0, MAX_SEARCH_PER_SCAN)

  if (needsScrape.length > 0) {
    console.log(`[scan:${tenant.name}] Playwright: scraping ${needsScrape.length} products...`)

    const { scrapeSearchResults, scrapeProductPage, closeBrowser } = await import('./playwright-scraper.js')

    try {
      for (let i = 0; i < needsScrape.length; i++) {
        const l = needsScrape[i] as any
        let offers: CompetitorOffer[] = []

        try {
          // Timeout wrapper: 60s max per product
          const scrapePromise = (async () => {
            // Strategy 1: Product page (if has catalog_product_id)
            if (l.catalog_product_id) {
              offers = await scrapeProductPage(l.catalog_product_id)
            }
            // Strategy 2: Search results (fallback or no catalog)
            if (offers.length === 0) {
              const query = buildSearchQuery(l.title ?? '', '')
              if (query && query.length >= 3) {
                offers = await scrapeSearchResults(query, 15)
              }
            }
          })()
          await Promise.race([
            scrapePromise,
            sleep(60000).then(() => { throw new Error('Playwright timeout 60s') })
          ])
        } catch (e: any) {
          console.error(`[scan:${tenant.name}] Playwright error for ${l.external_item_id}:`, e.message)
          errorCount++
        }

        // Filter self
        const filtered = offers.filter(o => {
          if (ourItemIds.has(o.item_id)) { selfFiltered++; return false }
          return true
        })

        if (filtered.length > 0) {
          playwrightHits += filtered.length
          allCompetitors.set(l.external_item_id, { extItemId: l.external_item_id, offers: filtered })
        }

        // Rate limit: 3s between pages, 60s pause every 10 products
        if (i < needsScrape.length - 1) {
          if ((i + 1) % 10 === 0) {
            console.log(`[scan:${tenant.name}] Playwright progress: ${i + 1}/${needsScrape.length} (${playwrightHits} hits) — pausing 60s to avoid ML block`)
            await sleep(60000) // 60s pause every 10 products
          } else {
            await sleep(3000)
          }
        }
      }
    } finally {
      await closeBrowser()
    }

    console.log(`[scan:${tenant.name}] Playwright: ${playwrightHits} competitors found`)
  }

  // 4. Enrich sellers + upsert
  const uniqueSellerIds = new Set<string>()
  for (const [, entry] of allCompetitors) {
    for (const o of entry.offers) uniqueSellerIds.add(o.seller_id)
  }

  // Load existing sellers
  const sellerDbMap = new Map<string, string>()
  const sellerArr = Array.from(uniqueSellerIds)
  for (let i = 0; i < sellerArr.length; i += 100) {
    const { data: existing } = await sb
      .from('competitor_sellers')
      .select('id, ml_seller_id')
      .eq('tenant_id', tenant.tenant_id)
      .in('ml_seller_id', sellerArr.slice(i, i + 100))

    for (const s of existing ?? []) {
      sellerDbMap.set(s.ml_seller_id, s.id)
    }
  }

  // Enrich + insert new sellers
  let sellersNew = 0
  let sellersUpdated = 0
  const newSellers = sellerArr.filter(id => !sellerDbMap.has(id)).slice(0, MAX_SELLER_ENRICHMENTS)

  for (let i = 0; i < newSellers.length; i += 5) {
    const batch = newSellers.slice(i, i + 5)
    const profiles = await Promise.allSettled(
      batch.map(async id => {
        const profile = await fetchSellerProfile(id, token)
        return { id, profile }
      })
    )

    for (const r of profiles) {
      if (r.status !== 'fulfilled') continue
      const { id, profile } = r.value
      const nickname = allCompetitors.values().next().value?.offers.find((o: any) => o.seller_id === id)?.seller_name ?? 'Unknown'
      const row = buildSellerRow(tenant.tenant_id, id, nickname, profile)
      const { data } = await sb.from('competitor_sellers').upsert(row, { onConflict: 'tenant_id,ml_seller_id' }).select('id').single()
      if (data) { sellerDbMap.set(id, data.id); sellersNew++ }
    }

    if (i + 5 < newSellers.length) await sleep(500)
  }

  // Insert remaining new sellers without profile
  for (const id of sellerArr.filter(id => !sellerDbMap.has(id))) {
    const nickname = 'Unknown'
    const row = buildSellerRow(tenant.tenant_id, id, nickname, null)
    const { data } = await sb.from('competitor_sellers').upsert(row, { onConflict: 'tenant_id,ml_seller_id' }).select('id').single()
    if (data) { sellerDbMap.set(id, data.id); sellersNew++ }
  }

  // Update last_seen for existing
  for (const id of sellerArr.filter(id => sellerDbMap.has(id) && !newSellers.includes(id))) {
    await sb.from('competitor_sellers')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('tenant_id', tenant.tenant_id)
      .eq('ml_seller_id', id)
    sellersUpdated++
  }

  // 5. Upsert competition_map
  let productsMapped = 0
  const allRows: Array<Record<string, unknown>> = []

  for (const [extItemId, entry] of allCompetitors) {
    const listing = listings.find((l: any) => l.external_item_id === extItemId) as any
    const ourPrice = Number(listing?.price ?? 0)

    const rows = entry.offers.map(o => {
      const dbSellerId = sellerDbMap.get(o.seller_id)
      if (!dbSellerId) return null

      return {
        tenant_id: tenant.tenant_id,
        product_id: listing?.product_id ?? null,
        external_item_id: extItemId,
        seller_id: dbSellerId,
        competitor_item_id: o.item_id,
        competitor_price: o.price,
        competitor_original_price: o.original_price,
        competitor_stock: o.available_quantity,
        competitor_sold_qty: o.sold_quantity,
        competitor_fulfillment: o.logistic_type === 'fulfillment' || o.logistic_type === 'cross_docking',
        competitor_catalog_listing: o.catalog_listing,
        competitor_shipping_free: true,
        fulfillment_type: o.logistic_type,
        permalink: o.permalink,
        price_diff_pct: ourPrice > 0
          ? Math.round(((o.price - ourPrice) / ourPrice) * 10000) / 100
          : null,
        catalog_product_id: listing?.catalog_product_id ?? null,
        is_catalog_winner: false,
        last_seen_at: new Date().toISOString(),
      }
    }).filter(Boolean)

    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50)
      const { error } = await sb
        .from('competition_map')
        .upsert(chunk, { onConflict: 'tenant_id,external_item_id,competitor_item_id' })
      if (!error) productsMapped += chunk.length
      else console.error(`[scan:${tenant.name}] Upsert error:`, error.message)
    }
    allRows.push(...(rows as any[]))
  }

  // 6. Mark catalog winners
  let winnersMarked = 0
  const catalogGroups = new Map<string, Array<Record<string, unknown>>>()
  for (const row of allRows) {
    const catId = row.catalog_product_id as string | null
    if (!catId) continue
    if (!catalogGroups.has(catId)) catalogGroups.set(catId, [])
    catalogGroups.get(catId)!.push(row)
  }

  for (const [catId, entries] of catalogGroups) {
    await sb.from('competition_map')
      .update({ is_catalog_winner: false })
      .eq('tenant_id', tenant.tenant_id)
      .eq('catalog_product_id', catId)
      .eq('is_catalog_winner', true)

    const cheapest = entries.reduce<Record<string, unknown> | null>((min, curr) => {
      const p = curr.competitor_price as number | null
      if (p == null) return min
      if (!min) return curr
      return p < (min.competitor_price as number) ? curr : min
    }, null)

    if (cheapest) {
      await sb.from('competition_map')
        .update({ is_catalog_winner: true })
        .eq('tenant_id', tenant.tenant_id)
        .eq('external_item_id', cheapest.external_item_id as string)
        .eq('competitor_item_id', cheapest.competitor_item_id as string)
      winnersMarked++
    }
  }

  const elapsed = Date.now() - start
  console.log(`[scan:${tenant.name}] Done in ${Math.round(elapsed / 1000)}s: ${allCompetitors.size} products, ${productsMapped} mappings, ${winnersMarked} winners`)

  return {
    tenant: tenant.name,
    items_scanned: listings.length,
    catalog_found: catalogFound,
    catalog_api_hits: catalogApiHits,
    playwright_hits: playwrightHits,
    self_filtered: selfFiltered,
    sellers_new: sellersNew,
    sellers_updated: sellersUpdated,
    products_mapped: productsMapped,
    winners_marked: winnersMarked,
    errors: errorCount,
    duration_ms: elapsed,
  }
}

function emptyResult(tenant: string, start: number): ScanResult {
  return { tenant, items_scanned: 0, catalog_found: 0, catalog_api_hits: 0, playwright_hits: 0, self_filtered: 0, sellers_new: 0, sellers_updated: 0, products_mapped: 0, winners_marked: 0, errors: 0, duration_ms: Date.now() - start }
}

function buildSellerRow(tenantId: string, sellerId: string, nickname: string, profile: SellerProfile | null) {
  const rep = profile?.seller_reputation
  const txTotal = rep?.transactions?.total ?? rep?.transactions?.completed ?? 0
  return {
    tenant_id: tenantId,
    ml_seller_id: sellerId,
    nickname: profile?.nickname ?? nickname,
    reputation_level: rep?.level_id ?? null,
    reputation_power_seller: rep?.power_seller_status != null && rep.power_seller_status !== 'null',
    transactions_completed: txTotal,
    positive_ratings_pct: rep?.ratings
      ? Math.round((rep.ratings.positive / Math.max(rep.ratings.positive + rep.ratings.negative + rep.ratings.neutral, 1)) * 10000) / 100
      : null,
    total_active_listings: null,
    logistic_types: [],
    official_store_id: null,
    raw_data: profile ?? null,
    last_seen_at: new Date().toISOString(),
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
