/**
 * Competition Monitor Server
 *
 * HTTP endpoint for on-demand scans + daily cron
 * Runs on Dokploy VPS where ML Search API works (cloud IP)
 */

import express from 'express'
import { CronJob } from 'cron'
import { loadTenants, PORT, CRON_SCHEDULE, API_KEY, type TenantConfig } from './config.js'
import { runScan, type ScanResult } from './scanner.js'

const app = express()
app.use(express.json())

const tenants = loadTenants()
let running = false

// ─── Health check ───────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', tenants: tenants.map(t => t.name), running })
})

// Debug: test Supabase connection per tenant
app.get('/debug/:tenant', async (req, res) => {
  const tenant = tenants.find(t => t.name.toLowerCase() === req.params.tenant.toLowerCase())
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(tenant.supabase_url, tenant.supabase_key)

    // Test 1: count listings
    const { count, error: listErr } = await sb
      .from('product_listings')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active')

    // Test 2: get token
    const { data: cred, error: credErr } = await sb
      .from('channel_credentials')
      .select('access_token, expires_at')
      .eq('channel_id', tenant.channel_id)
      .limit(1)
      .single()

    // Test 3: ML Search API test (from VPS IP)
    const { default: axios } = await import('axios')
    let searchTest = 'untested'
    try {
      const r = await axios.get('https://api.mercadolibre.com/sites/MLA/search?q=iphone&limit=1', { timeout: 5000 })
      searchTest = `OK: ${r.data?.paging?.total ?? 0} results`
    } catch (e: any) {
      searchTest = `FAIL: ${e?.response?.status ?? e.message}`
    }

    res.json({
      tenant: tenant.name,
      supabase_url: tenant.supabase_url,
      channel_id: tenant.channel_id,
      listings_count: count,
      listings_error: listErr?.message ?? null,
      token_found: !!cred?.access_token,
      token_expires: cred?.expires_at ?? null,
      token_error: credErr?.message ?? null,
      search_api: searchTest,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ─── Scan endpoint ──────────────────────────────────────────────────────────

app.post('/scan', async (req, res) => {
  // Auth check
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' })
  }

  if (running) {
    return res.status(409).json({ error: 'Scan already in progress' })
  }

  const tenantName = req.query.tenant as string | undefined
  const targetTenants = tenantName
    ? tenants.filter(t => t.name.toLowerCase() === tenantName.toLowerCase())
    : tenants

  if (targetTenants.length === 0) {
    return res.status(404).json({ error: `Tenant "${tenantName}" not found`, available: tenants.map(t => t.name) })
  }

  running = true
  const results: ScanResult[] = []

  try {
    for (const tenant of targetTenants) {
      try {
        const result = await runScan(tenant)
        results.push(result)
      } catch (e: any) {
        console.error(`[server] Scan failed for ${tenant.name}:`, e.message)
        results.push({
          tenant: tenant.name,
          items_scanned: 0, catalog_found: 0, catalog_api_hits: 0,
          search_api_hits: 0, self_filtered: 0, sellers_new: 0,
          sellers_updated: 0, products_mapped: 0, winners_marked: 0,
          errors: 1, duration_ms: 0,
        })
      }
    }

    res.json({ ok: true, results })
  } finally {
    running = false
  }
})

// ─── Scan single tenant (GET for easy webhook) ─────────────────────────────

app.get('/scan/:tenant', async (req, res) => {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY && req.query.key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' })
  }

  if (running) return res.status(409).json({ error: 'Scan already in progress' })

  const tenant = tenants.find(t => t.name.toLowerCase() === req.params.tenant.toLowerCase())
  if (!tenant) return res.status(404).json({ error: `Tenant "${req.params.tenant}" not found` })

  running = true
  try {
    const result = await runScan(tenant)
    res.json({ ok: true, result })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  } finally {
    running = false
  }
})

// ─── Cron job ───────────────────────────────────────────────────────────────

const cronJob = new CronJob(CRON_SCHEDULE, async () => {
  if (running) {
    console.log('[cron] Scan already running, skipping')
    return
  }

  console.log(`[cron] Starting daily scan for ${tenants.length} tenants...`)
  running = true

  for (const tenant of tenants) {
    try {
      await runScan(tenant)
    } catch (e: any) {
      console.error(`[cron] Scan failed for ${tenant.name}:`, e.message)
    }
  }

  running = false
  console.log('[cron] Daily scan complete')
}, null, true, 'America/Argentina/Buenos_Aires')

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Competition Monitor running on :${PORT}`)
  console.log(`[server] Tenants: ${tenants.map(t => t.name).join(', ')}`)
  console.log(`[server] Cron: ${CRON_SCHEDULE}`)
  console.log(`[server] Endpoints:`)
  console.log(`  GET  /health`)
  console.log(`  POST /scan`)
  console.log(`  POST /scan?tenant=lubbi`)
  console.log(`  GET  /scan/lubbi`)
  cronJob.start()
})
