/**
 * Multi-tenant configuration
 *
 * Two modes:
 * 1. TENANTS_CONFIG env var: JSON array (for programmatic config)
 * 2. TENANT_<N>_* env vars: one set per tenant (for Dokploy .env format)
 *    TENANT_1_NAME=lubbi
 *    TENANT_1_SUPABASE_URL=https://xxx.supabase.co
 *    TENANT_1_SUPABASE_KEY=eyJ...
 *    TENANT_1_ML_SELLER_ID=1074767186
 *    TENANT_1_TENANT_ID=uuid
 *    TENANT_1_CHANNEL_ID=uuid
 */

export interface TenantConfig {
  name: string
  supabase_url: string
  supabase_key: string
  ml_seller_id: string
  tenant_id: string
  channel_id: string
}

export function loadTenants(): TenantConfig[] {
  // Mode 1: JSON config
  const raw = process.env.TENANTS_CONFIG
  if (raw) {
    try {
      const tenants = JSON.parse(raw) as TenantConfig[]
      console.log(`[config] JSON mode: ${tenants.length} tenants: ${tenants.map(t => t.name).join(', ')}`)
      return tenants
    } catch (e) {
      console.error('[config] Failed to parse TENANTS_CONFIG:', e)
    }
  }

  // Mode 2: Numbered env vars
  const tenants: TenantConfig[] = []
  for (let i = 1; i <= 10; i++) {
    const name = process.env[`TENANT_${i}_NAME`]
    if (!name) break
    tenants.push({
      name,
      supabase_url: process.env[`TENANT_${i}_SUPABASE_URL`] ?? '',
      supabase_key: process.env[`TENANT_${i}_SUPABASE_KEY`] ?? '',
      ml_seller_id: process.env[`TENANT_${i}_ML_SELLER_ID`] ?? '',
      tenant_id: process.env[`TENANT_${i}_TENANT_ID`] ?? '',
      channel_id: process.env[`TENANT_${i}_CHANNEL_ID`] ?? '',
    })
  }

  if (tenants.length > 0) {
    console.log(`[config] Env mode: ${tenants.length} tenants: ${tenants.map(t => t.name).join(', ')}`)
  } else {
    console.error('[config] No tenants configured. Set TENANT_1_NAME, TENANT_1_SUPABASE_URL, etc.')
  }

  return tenants
}

export const PORT = Number(process.env.PORT ?? 3100)
export const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '0 9 * * *'
export const API_KEY = process.env.API_KEY ?? ''
