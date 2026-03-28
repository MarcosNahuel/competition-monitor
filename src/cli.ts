/**
 * CLI for manual scans
 * Usage: npx tsx src/cli.ts scan [--tenant lubbi]
 */

import { loadTenants } from './config.js'
import { runScan } from './scanner.js'

const args = process.argv.slice(2)
const cmd = args[0]

if (cmd !== 'scan') {
  console.log('Usage: npx tsx src/cli.ts scan [--tenant <name>]')
  process.exit(1)
}

const tenantArg = args.indexOf('--tenant')
const tenantName = tenantArg >= 0 ? args[tenantArg + 1] : undefined

const tenants = loadTenants()
const targets = tenantName
  ? tenants.filter(t => t.name.toLowerCase() === tenantName.toLowerCase())
  : tenants

if (targets.length === 0) {
  console.error(`No tenants found${tenantName ? ` matching "${tenantName}"` : ''}`)
  process.exit(1)
}

;(async () => {
  for (const tenant of targets) {
    try {
      const result = await runScan(tenant)
      console.log(JSON.stringify(result, null, 2))
    } catch (e) {
      console.error(`Scan failed for ${tenant.name}:`, e)
    }
  }
})()
