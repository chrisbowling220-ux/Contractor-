// One-time cleanup of pre-schema estimate documents.
// Pre-schema docs have `aiScope` (string) instead of `scopeOfWork` + `aiQuote`,
// and `amount` (string) instead of `total` (number).
//
// Usage:
//   node scripts/cleanupOldEstimates.mjs        # dry run — lists matches, deletes nothing
//   node scripts/cleanupOldEstimates.mjs --yes  # actually delete

import { initializeApp, cert, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { readFileSync, existsSync } from 'node:fs'

const PROJECT_ID = 'contractors-office-96731'
const SA_KEY_PATH = new URL('./serviceAccountKey.json', import.meta.url).pathname

const credential = existsSync(SA_KEY_PATH)
  ? cert(JSON.parse(readFileSync(SA_KEY_PATH, 'utf8')))
  : applicationDefault()

initializeApp({ credential, projectId: PROJECT_ID })
const db = getFirestore()

const dryRun = !process.argv.includes('--yes')

const snap = await db.collection('estimates').get()
const stale = snap.docs.filter(d => {
  const x = d.data()
  return 'aiScope' in x || typeof x.amount === 'string' || !('scopeOfWork' in x)
})

console.log(`Total estimates: ${snap.size}`)
console.log(`Stale (pre-schema) matches: ${stale.length}`)
for (const d of stale) {
  const x = d.data()
  console.log(`  - ${d.id}  customer="${x.customerName}"  createdAt=${x.createdAt}`)
}

if (dryRun) {
  console.log('\nDry run. Re-run with --yes to actually delete.')
  process.exit(0)
}

for (const d of stale) await d.ref.delete()
console.log(`\nDeleted ${stale.length} document(s).`)
