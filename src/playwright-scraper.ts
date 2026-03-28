/**
 * Playwright Scraper — extrae competidores de MercadoLibre via browser
 *
 * Dos estrategias:
 * 1. scrapeSearchResults(query) — busca en listado.mercadolibre.com.ar
 * 2. scrapeProductPage(catalogProductId) — scrape de /p/{id} (como AGUS Layer C)
 */

import { chromium, type Browser, type Page } from 'playwright'
import type { CompetitorOffer } from './ml-api.js'

let browser: Browser | null = null

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        `--user-agent=${USER_AGENT}`,
      ],
    })
    console.log('[playwright] Browser launched')
  }
  return browser
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {})
    browser = null
    console.log('[playwright] Browser closed')
  }
}

// ─── Strategy 1: Search Results Page ────────────────────────────────────────

export async function scrapeSearchResults(
  query: string,
  maxResults: number = 20
): Promise<CompetitorOffer[]> {
  const b = await getBrowser()
  const ctx = await b.newContext({
    userAgent: USER_AGENT,
    locale: 'es-AR',
    viewport: { width: 1366, height: 768 },
  })
  const page = await ctx.newPage()

  // Anti-detection: hide webdriver
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })

  const offers: CompetitorOffer[] = []

  try {
    const encoded = encodeURIComponent(query).replace(/%20/g, '-')
    const url = `https://listado.mercadolibre.com.ar/${encoded}`
    console.log(`[playwright] Searching: ${url}`)

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000) // Wait for dynamic content

    // Extract search result cards
    const results = await page.evaluate((max) => {
      const items: Array<{
        itemId: string | null
        title: string
        price: number | null
        sellerName: string | null
        permalink: string | null
        hasFulfillment: boolean
        hasFreeShipping: boolean
      }> = []

      // Search result selectors (ML Argentina 2026)
      const cards = document.querySelectorAll(
        '.ui-search-layout__item, .ui-search-result__wrapper, [class*="ui-search-result"]'
      )

      for (const card of Array.from(cards).slice(0, max)) {
        // Price
        const priceEl = card.querySelector('.andes-money-amount__fraction, [class*="price-tag-fraction"]')
        const priceText = priceEl?.textContent?.replace(/\./g, '').replace(/,/g, '.').trim()
        const price = priceText ? parseFloat(priceText) : null

        // Title + Link
        const linkEl = card.querySelector('a.ui-search-link, a.ui-search-item__group__element, a[class*="ui-search-link"]') as HTMLAnchorElement
        const title = linkEl?.textContent?.trim() ?? card.querySelector('h2')?.textContent?.trim() ?? ''
        const permalink = linkEl?.href ?? null

        // Extract item ID from URL
        let itemId: string | null = null
        if (permalink) {
          const match = permalink.match(/MLA-?(\d+)/)
          if (match) itemId = `MLA${match[1]}`
        }

        // Seller
        const sellerEl = card.querySelector('.ui-search-official-store-label, [class*="seller"]')
        const sellerName = sellerEl?.textContent?.trim() ?? null

        // Fulfillment badge
        const fulfillmentEl = card.querySelector('[class*="fulfillment"], [class*="full"]')
        const hasFulfillment = !!fulfillmentEl

        // Free shipping badge
        const shippingEl = card.querySelector('[class*="free-shipping"], .ui-search-item__shipping')
        const hasFreeShipping = !!shippingEl

        if (price && price > 0) {
          items.push({ itemId, title, price, sellerName, permalink, hasFulfillment, hasFreeShipping })
        }
      }

      return items
    }, maxResults)

    for (const r of results) {
      offers.push({
        seller_id: '0', // Unknown from search results
        seller_name: r.sellerName ?? 'Desconocido',
        item_id: r.itemId ?? `browser_search_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        price: r.price!,
        original_price: null,
        logistic_type: r.hasFulfillment ? 'fulfillment' : null,
        available_quantity: null,
        sold_quantity: null,
        permalink: r.permalink,
        catalog_listing: false,
        source: 'search',
      })
    }

    console.log(`[playwright] Search "${query}": ${offers.length} offers found`)
  } catch (e: any) {
    console.error(`[playwright] Search error for "${query}":`, e.message)
  } finally {
    await page.close().catch(() => {})
  }

  return offers
}

// ─── Strategy 2: Product Detail Page ────────────────────────────────────────

export async function scrapeProductPage(
  catalogProductId: string
): Promise<CompetitorOffer[]> {
  const b = await getBrowser()
  const ctx = await b.newContext({
    userAgent: USER_AGENT,
    locale: 'es-AR',
    viewport: { width: 1366, height: 768 },
  })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })
  const offers: CompetitorOffer[] = []

  try {
    const url = `https://www.mercadolibre.com.ar/p/${catalogProductId}`
    console.log(`[playwright] Product page: ${url}`)

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000)

    // Pass 1: JSON-LD extraction (most reliable)
    const jsonLdOffers = await extractJsonLd(page)
    if (jsonLdOffers.length > 0) {
      offers.push(...jsonLdOffers)
      console.log(`[playwright] JSON-LD: ${jsonLdOffers.length} offers from ${catalogProductId}`)
      return offers
    }

    // Pass 2: DOM extraction (fallback)
    const domOffers = await extractDom(page)
    offers.push(...domOffers)
    console.log(`[playwright] DOM: ${domOffers.length} offers from ${catalogProductId}`)
  } catch (e: any) {
    console.error(`[playwright] Product page error for ${catalogProductId}:`, e.message)
  } finally {
    await page.close().catch(() => {})
  }

  return offers
}

// ─── JSON-LD Extraction (ported from AGUS) ──────────────────────────────────

async function extractJsonLd(page: Page): Promise<CompetitorOffer[]> {
  try {
    return await page.evaluate(() => {
      const offers: Array<{
        itemId: string | null
        sellerName: string | null
        price: number
        permalink: string | null
      }> = []

      const scripts = document.querySelectorAll('script[type="application/ld+json"]')
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent ?? '{}')
          const products = data['@graph']
            ? data['@graph'].filter((n: any) => n['@type'] === 'Product')
            : data['@type'] === 'Product' ? [data] : []

          for (const product of products) {
            const rawOffers = product.offers?.offers ?? (product.offers ? [product.offers] : [])
            for (const o of rawOffers) {
              const price = parseFloat(String(o.price ?? o.lowPrice ?? 0))
              if (!isFinite(price) || price <= 0) continue

              let itemId: string | null = null
              const url = String(o.url ?? '')
              const match = url.match(/MLA-?(\d+)/)
              if (match) itemId = `MLA${match[1]}`

              const sellerName = typeof o.seller === 'object' ? o.seller?.name : o.seller ?? null

              offers.push({
                itemId: itemId ?? `browser_jsonld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                sellerName,
                price,
                permalink: url || null,
              })
            }
          }
        } catch { /* skip malformed JSON-LD */ }
      }

      return offers
    })
    .then(raw => raw.map(r => ({
      seller_id: '0',
      seller_name: r.sellerName ?? 'Desconocido',
      item_id: r.itemId ?? `browser_jsonld_${Date.now()}`,
      price: r.price,
      original_price: null,
      logistic_type: null,
      available_quantity: null,
      sold_quantity: null,
      permalink: r.permalink,
      catalog_listing: true,
      source: 'search' as const,
    })))
  } catch {
    return []
  }
}

// ─── DOM Extraction (ported from AGUS) ──────────────────────────────────────

async function extractDom(page: Page): Promise<CompetitorOffer[]> {
  try {
    return await page.evaluate(() => {
      const offers: Array<{
        itemId: string | null
        sellerName: string | null
        price: number
        permalink: string | null
      }> = []

      // Try multiple selector strategies
      const containers = document.querySelectorAll(
        '[data-testid="pdp-offers"] [data-testid="offer-item"], ' +
        '[data-testid="seller-card"], ' +
        '.sellers-list__item, ' +
        '.ui-pdp-other-sellers__item'
      )

      for (const el of containers) {
        // Price
        const fractionEl = el.querySelector('[data-testid="price-fraction"], .price-tag-fraction, .andes-money-amount__fraction')
        const centsEl = el.querySelector('[data-testid="price-cents"], .price-tag-cents, .andes-money-amount__cents')
        const fraction = fractionEl?.textContent?.replace(/\./g, '').trim() ?? '0'
        const cents = centsEl?.textContent?.trim() ?? '00'
        const price = parseFloat(`${fraction}.${cents}`)
        if (!isFinite(price) || price <= 0) continue

        // Seller
        const sellerEl = el.querySelector('[data-testid="seller-name"], .seller-name, [class*="seller"]')
        const sellerName = sellerEl?.textContent?.trim() ?? null

        // Link
        const linkEl = el.querySelector('a[href*="MLA"]') as HTMLAnchorElement | null
        const permalink = linkEl?.href ?? null
        let itemId: string | null = null
        if (permalink) {
          const match = permalink.match(/MLA-?(\d+)/)
          if (match) itemId = `MLA${match[1]}`
        }

        offers.push({
          itemId: itemId ?? `browser_dom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          sellerName,
          price,
          permalink,
        })
      }

      return offers
    })
    .then(raw => raw.map(r => ({
      seller_id: '0',
      seller_name: r.sellerName ?? 'Desconocido',
      item_id: r.itemId ?? `browser_dom_${Date.now()}`,
      price: r.price,
      original_price: null,
      logistic_type: null,
      available_quantity: null,
      sold_quantity: null,
      permalink: r.permalink,
      catalog_listing: false,
      source: 'search' as const,
    })))
  } catch {
    return []
  }
}
