// One-time cleaning of estimates saved before estimate privacy (see
// src/lib/estimatePrivacy.ts). A customer's link hands over the whole
// estimate document, and older AI quotes still carry the contractor's private
// notes, the markup, cost-price subtotals and the spoken walkthrough.
//
// For each such estimate, in ONE atomic write:
//   - estimatePrivate/{id} gets the private values (fields it already has are
//     never overwritten), owned by the estimate's contractor;
//   - the estimate keeps only the customer view, with exactly the same
//     totals, prices and wording the customer has always been shown.
// The write is refused if the estimate changed since it was read, so a
// contractor editing at the same moment is never overwritten (re-run later).
//
// Uses the same code as the app (src/lib/estimatePrivacy.ts) and refuses any
// estimate whose customer-visible content would differ after cleaning.
// Prints counts only: never names, notes, amounts or estimate ids (an
// estimate id IS its share link).
//
//   node --experimental-strip-types scripts/migrate-estimate-privacy.mjs --project <id>
//       dry run (default): reads everything, writes nothing
//   ... --write [--backup-dir <dir>]
//       writes a backup first (original fields, lossless, mode 600), then cleans
//   ... --restore <backup.json> [--write]
//       puts the original estimate fields back from a backup (dry run unless
//       --write). Leaves estimatePrivate in place.
//
// Against the emulator, set FIRESTORE_EMULATOR_HOST (e.g. 127.0.0.1:8380).
// Against a real project it signs in with the Firebase CLI's login.
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect, listRaw, toFields } from './lib/firestore-rest.mjs'
import {
  ESTIMATE_PRIVATE_COLLECTION, customerVisibleContent, splitEstimateForSharing,
} from '../src/lib/estimatePrivacy.ts'
import { sameContent } from '../src/lib/publicCopies.ts'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const project = value('--project')
const write = flag('--write')
const restoreFrom = value('--restore')
const backupDir = value('--backup-dir') || join(homedir(), 'buildpro-backups')
if (!project) { console.error('Usage: --project <id> [--write] [--backup-dir <dir>] | --restore <backup.json> [--write]'); process.exit(2) }

const conn = connect(project)
const { request, docsPath, emulator } = conn
const where = `Project ${project}${emulator ? ` (emulator ${emulator})` : ''}`
// A short, one-way tag for an estimate, so a failure can be matched to the
// backup file without printing the share-link id itself.
const tag = (id) => createHash('sha256').update(id).digest('hex').slice(0, 10)

function writeBackup(entries) {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(backupDir, `estimate-privacy-${project}-${stamp}.json`)
  const fd = openSync(file, 'wx', 0o600)
  writeSync(fd, JSON.stringify({ project, takenAt: new Date().toISOString(), entries }, null, 1))
  fsyncSync(fd)
  closeSync(fd)
  return file
}

// ── Restore ─────────────────────────────────────────────────────────────────
if (restoreFrom) {
  const backup = JSON.parse(readFileSync(restoreFrom, 'utf8'))
  if (backup.project !== project) { console.error(`Backup is for project ${backup.project}, not ${project}.`); process.exit(2) }
  console.log(`${where}: RESTORE from backup taken ${backup.takenAt}: ${write ? 'WRITING' : 'dry run, nothing written'}`)
  console.log(`Estimates in backup: ${backup.entries.length}`)
  let restored = 0, failed = 0
  if (write) {
    for (const e of backup.entries) {
      const paths = Object.keys(e.fields)
      // A field that did not exist before is removed (in the mask, absent from fields).
      const fields = Object.fromEntries(Object.entries(e.fields).filter(([, v]) => v !== null))
      try {
        await request('POST', `${docsPath}:commit`, {
          writes: [{ update: { name: e.name, fields }, updateMask: { fieldPaths: paths }, currentDocument: { exists: true } }],
        })
        restored++
      } catch (err) {
        failed++
        console.log(`  could not restore estimate #${tag(e.name.split('/').pop())}: ${err.message}`)
      }
    }
    console.log(`Restored ${restored}, failed ${failed}.`)
  }
  process.exit(failed ? 1 : 0)
}

// ── Plan ────────────────────────────────────────────────────────────────────
const [estimates, privates] = await Promise.all([listRaw(conn, 'estimates'), listRaw(conn, ESTIMATE_PRIVATE_COLLECTION)])
const havePrivate = new Map(privates.map(p => [p.id, p.data]))

const counts = {
  read: estimates.length, withAiQuote: 0, quickQuotes: 0, alreadyClean: 0, toClean: 0,
  signed: 0, pending: 0, declined: 0, otherStatus: 0,
  notes: 0, markup: 0, narration: 0, subtotals: 0, privateCreate: 0, privateMerge: 0,
  failed: 0,
}
const failures = []
const plan = []

for (const est of estimates) {
  const e = est.data
  if (e.aiQuote) counts.withAiQuote++
  if (e.jobTypeId === 'quick-quote') counts.quickQuotes++
  const split = splitEstimateForSharing(e)
  if (split.error) { counts.failed++; failures.push(`estimate #${tag(est.id)}: ${split.error}`); continue }
  if (!split.needed) { counts.alreadyClean++; continue }
  if (typeof e.createdBy !== 'string' || !e.createdBy) {
    counts.failed++; failures.push(`estimate #${tag(est.id)}: no owner (createdBy), left as is`); continue
  }
  if (!sameContent(customerVisibleContent(e), customerVisibleContent({ ...e, ...split.publicPatch }))) {
    counts.failed++; failures.push(`estimate #${tag(est.id)}: cleaning would change what the customer sees, left as is`); continue
  }
  counts.toClean++
  const status = e.status === 'approved' ? 'signed' : e.status === 'pending' ? 'pending' : e.status === 'declined' ? 'declined' : 'otherStatus'
  counts[status]++
  const pf = split.privateFields
  if (pf.contractorNotes) counts.notes++
  if ('aiMarkupDollars' in pf) counts.markup++
  if (pf.narration) counts.narration++
  if (['laborTotal', 'materialsTotal', 'rentalsTotal'].some(k => k in split.publicPatch)) counts.subtotals++

  // Private values: never overwrite one the app already saved.
  const existing = havePrivate.get(est.id)
  const privateData = { createdBy: e.createdBy }
  for (const [k, v] of Object.entries(pf)) if (!existing || !(k in existing)) privateData[k] = v
  if (existing && existing.createdBy && existing.createdBy !== e.createdBy) {
    counts.toClean--; counts[status]--; counts.failed++
    failures.push(`estimate #${tag(est.id)}: its private record belongs to someone else, left as is`)
    continue
  }
  counts[existing ? 'privateMerge' : 'privateCreate']++
  plan.push({ est, patch: split.publicPatch, privateData, privateExists: !!existing })
}

console.log(`${where}: ${write ? 'CLEANING' : 'dry run, nothing written'}`)
console.log(`Read: ${counts.read} estimates (${counts.withAiQuote} with an AI quote, ${counts.quickQuotes} Quick Quotes), ${privates.length} private records.`)
console.log(`Already customer-safe: ${counts.alreadyClean}.`)
console.log(`To clean: ${counts.toClean} (signed ${counts.signed}, pending ${counts.pending}, declined ${counts.declined}, other ${counts.otherStatus}).`)
console.log(`  carrying private notes: ${counts.notes}; markup figures: ${counts.markup}; spoken walkthrough: ${counts.narration}; cost-price subtotals: ${counts.subtotals}.`)
console.log(`Private records: ${counts.privateCreate} to create, ${counts.privateMerge} to add to.`)
console.log(`Failures (left exactly as they are): ${counts.failed}.`)
for (const f of failures) console.log(`  ${f}`)

if (!write || plan.length === 0) process.exit(counts.failed ? 1 : 0)

// ── Backup, then clean ──────────────────────────────────────────────────────
// The backup holds each estimate's ORIGINAL raw fields for every field the
// cleaning changes (null = the field did not exist), so --restore is exact.
const backupFile = writeBackup(plan.map(({ est, patch }) => ({
  name: est.name,
  updateTime: est.updateTime,
  fields: Object.fromEntries(Object.keys(patch).map(k => [k, est.fields[k] ?? null])),
})))
console.log(`Backup written (owner-only file): ${backupFile}`)

let cleaned = 0, refused = 0
for (const { est, patch, privateData, privateExists } of plan) {
  const privName = `${docsPath}/${ESTIMATE_PRIVATE_COLLECTION}/${est.id}`
  try {
    await request('POST', `${docsPath}:commit`, {
      writes: [
        {
          update: { name: privName, fields: toFields(privateData) },
          updateMask: { fieldPaths: Object.keys(privateData) },
          currentDocument: { exists: privateExists },
        },
        {
          update: { name: est.name, fields: toFields(patch) },
          updateMask: { fieldPaths: Object.keys(patch) },
          // Only if nobody changed it since it was read.
          currentDocument: { updateTime: est.updateTime },
        },
      ],
    })
    cleaned++
  } catch (err) {
    refused++
    console.log(`  estimate #${tag(est.id)} not cleaned (${err.message}); it changed or its private record appeared meanwhile. Re-run to retry.`)
  }
}
console.log(`Cleaned ${cleaned}; not cleaned ${refused}.`)
process.exit(refused || counts.failed ? 1 : 0)
