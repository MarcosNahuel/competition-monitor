/**
 * Multi-tenant configuration
 *
 * TENANTS_CONFIG env var: JSON array of tenant configs
 * Each tenant needs: name, supabase_url, supabase_key, ml_seller_id, tenant_id, channel_id
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
  const raw = process.env.TENANTS_CONFIG
  if (!raw) {
    console.error('[config] TENANTS_CONFIG env var not set')
    return []
  }
  try {
    const tenants = JSON.parse(raw) as TenantConfig[]
    console.log(`[config] Loaded ${tenants.length} tenants: ${tenants.map(t => t.name).join(', ')}`)
    return tenants
  } catch (e) {
    console.error('[config] Failed to parse TENANTS_CONFIG:', e)
    return []
  }
}

export const PORT = Number(process.env.PORT ?? 3100)
export const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '0 9 * * *' // 9 AM UTC daily
export const API_KEY = process.env.API_KEY ?? ''
