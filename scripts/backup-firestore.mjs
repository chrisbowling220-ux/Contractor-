// A complete, exact copy of the Firestore database, kept on this machine.
// A free stand-in for the paid Cloud Storage export: every document in every
// collection and subcollection, with its raw fields (lossless: timestamps,
// integers vs decimals, maps and lists exactly as stored) and update times.
//
// Prints counts only, never contents. The file is owner-only (mode 600) in an
// owner-only folder; it holds customer details, so keep it on this machine.
//
//   node scripts/backup-firestore.mjs --project <id> [--out <dir>]
//       read-only: writes ~/buildpro-backups/firestore-<project>-<time>.json
//   node scripts/backup-firestore.mjs --project <id> --compare <backup.json>
//       read-only: how many documents changed, appeared or disappeared since
//   node scripts/backup-firestore.mjs --project <id> --restore <backup.json> [--only <collection>] [--write]
//       puts documents back exactly as they were in the backup (whole
//       documents; dry run unless --write). Never deletes anything.
//
// A backup restores only into the project it was taken from, except into a
// local emulator project named demo-* (used by the release rehearsal).
// Against the emulator, set FIRESTORE_EMULATOR_HOST.
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from './lib/firestore-rest.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const project = value('--project')
const outDir = value('--out') || join(homedir(), 'buildpro-backups')
const restoreFrom = value('--restore')
const compareWith = value('--compare')
const only = value('--only')
const write = flag('--write')
if (!project) {
  console.error('Usage: --project <id> [--out <dir>] | --compare <backup.json> | --restore <backup.json> [--only <collection>] [--write]')
  process.exit(2)
}

const conn = connect(project)
const { request, docsPath, emulator } = conn
const where = `Project ${project}${emulator ? ` (emulator ${emulator})` : ''}`

// "estimates/abc" -> "estimates"; "voiceUsage/u1/months/2026-11" -> "voiceUsage/*/months"
const groupOf = (relName) => relName.split('/').map((p, i) => (i % 2 ? '*' : p)).slice(0, -1).join('/')
const relative = (name) => name.slice(name.indexOf('/documents/') + '/documents/'.length)

async function collectionIds(parent) {
  const ids = []
  let pageToken
  do {
    const page = await request('POST', `${parent}:listCollectionIds`, { pageSize: 300, ...(pageToken ? { pageToken } : {}) })
    ids.push(...(page.collectionIds || []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return ids
}

// Every document under `parent`, depth first. showMissing also returns parent
// paths that have subcollections but no document of their own (e.g.
// voiceUsage/{user}), so nothing nested under them is skipped.
async function readAll(parent, out) {
  for (const cid of await collectionIds(parent)) {
    let pageToken
    do {
      const page = await request('GET', `${parent}/${cid}`, undefined, { pageSize: '300', showMissing: 'true', ...(pageToken ? { pageToken } : {}) })
      for (const d of page.documents || []) {
        if (d.createTime) out.push({ name: d.name, createTime: d.createTime, updateTime: d.updateTime, fields: d.fields || {} })
        await readAll(d.name, out)
      }
      pageToken = page.nextPageToken
    } while (pageToken)
  }
  return out
}

const countByGroup = (docs) => {
  const m = new Map()
  for (const d of docs) { const g = groupOf(relative(d.name)); m.set(g, (m.get(g) || 0) + 1) }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
}

// ── Restore ─────────────────────────────────────────────────────────────────
if (restoreFrom) {
  const backup = JSON.parse(readFileSync(restoreFrom, 'utf8'))
  const crossProject = backup.project !== project
  if (crossProject && !(emulator && project.startsWith('demo-'))) {
    console.error(`Backup is for project ${backup.project}; it restores only there (or into a demo-* emulator project).`)
    process.exit(2)
  }
  const fromPrefix = `projects/${backup.project}/databases/(default)/documents`
  // Re-home names (and any document references) into the target project.
  const rehome = (v) => {
    if (typeof v === 'string') return v.startsWith(fromPrefix) ? docsPath + v.slice(fromPrefix.length) : v
    if (Array.isArray(v)) return v.map(rehome)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'referenceValue' || typeof x === 'object' ? rehome(x) : x]))
    return v
  }
  const docs = backup.documents.filter(d => !only || relative(d.name).split('/')[0] === only)
  console.log(`${where}: RESTORE ${docs.length} documents${only ? ` of ${only}` : ''} from backup of ${backup.project} taken ${backup.takenAt}: ${write ? 'WRITING' : 'dry run, nothing written'}`)
  if (!write) process.exit(0)
  let restored = 0, failed = 0
  // Batches of up to 400 writes; each document is replaced whole.
  for (let i = 0; i < docs.length; i += 400) {
    const writes = docs.slice(i, i + 400).map(d => ({ update: { name: crossProject ? rehome(d.name) : d.name, fields: crossProject ? rehome(d.fields) : d.fields } }))
    try {
      await request('POST', `${docsPath}:commit`, { writes })
      restored += writes.length
    } catch (err) {
      failed += writes.length
      console.log(`  batch of ${writes.length} not restored: ${err.message}`)
    }
  }
  console.log(`Restored ${restored}, failed ${failed}.`)
  process.exit(failed ? 1 : 0)
}

// ── Read everything ─────────────────────────────────────────────────────────
const live = await readAll(docsPath, [])

// ── Compare ─────────────────────────────────────────────────────────────────
if (compareWith) {
  const backup = JSON.parse(readFileSync(compareWith, 'utf8'))
  if (backup.project !== project) { console.error(`Backup is for project ${backup.project}, not ${project}.`); process.exit(2) }
  const before = new Map(backup.documents.map(d => [relative(d.name), d]))
  const now = new Map(live.map(d => [relative(d.name), d]))
  const tally = new Map()
  const bump = (g, k) => { const t = tally.get(g) || { same: 0, changed: 0, added: 0, gone: 0 }; t[k]++; tally.set(g, t) }
  for (const [rel, d] of now) {
    const b = before.get(rel)
    if (!b) bump(groupOf(rel), 'added')
    else bump(groupOf(rel), JSON.stringify(b.fields) === JSON.stringify(d.fields) ? 'same' : 'changed')
  }
  for (const rel of before.keys()) if (!now.has(rel)) bump(groupOf(rel), 'gone')
  console.log(`${where} compared with the backup taken ${backup.takenAt}:`)
  for (const [g, t] of [...tally.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${g.padEnd(36)} same ${t.same}, changed ${t.changed}, new ${t.added}, gone ${t.gone}`)
  }
  process.exit(0)
}

// ── Back up ─────────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true, mode: 0o700 })
const takenAt = new Date().toISOString()
const file = join(outDir, `firestore-${project}-${takenAt.replace(/[:.]/g, '-')}.json`)
const body = JSON.stringify({ project, takenAt, documents: live })
const fd = openSync(file, 'wx', 0o600)
writeSync(fd, body)
fsyncSync(fd)
closeSync(fd)

// Read it back and check it parses to the same documents before calling it a backup.
const check = JSON.parse(readFileSync(file, 'utf8'))
if (check.documents.length !== live.length) { console.error('Backup file did not read back intact.'); process.exit(1) }

console.log(`${where}: backed up ${live.length} documents to ${file}`)
console.log(`  sha256 ${createHash('sha256').update(body).digest('hex')}`)
for (const [g, n] of countByGroup(live)) console.log(`  ${g.padEnd(36)} ${n}`)
