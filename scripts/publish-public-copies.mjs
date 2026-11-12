// One-time publish of the customer-safe copies for EVERY contractor, so the
// final Firestore rules (step 3) can close the old public reads right after
// the new app is released, instead of waiting for each contractor to open it.
//
//   publicProfiles/{userId}    business card, from users/{userId}
//   photoLogs/{customerId}     name, address and photo list, from customers +
//                              customerPhotos (only customers that have photos)
//
// Uses exactly the builders the app uses (src/lib/publicCopies.ts), skips
// copies that are already up to date, and writes nothing else. Prints counts
// only, never document contents.
//
//   node --experimental-strip-types scripts/publish-public-copies.mjs --project <id>            # dry run
//   node --experimental-strip-types scripts/publish-public-copies.mjs --project <id> --write    # publish
//
// Against the emulator, set FIRESTORE_EMULATOR_HOST (e.g. 127.0.0.1:8380).
// Against a real project it signs in with the Firebase CLI's login.
import { createRequire } from 'node:module'
import { buildPhotoLog, publicProfileFrom, sameContent } from '../src/lib/publicCopies.ts'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const project = value('--project')
const write = flag('--write')
if (!project) { console.error('Usage: --project <id> [--write]'); process.exit(2) }

const emulator = process.env.FIRESTORE_EMULATOR_HOST
const docsPath = `projects/${project}/databases/(default)/documents`

// ── Firestore REST, against the emulator or the real project ────────────────
let request
if (emulator) {
  request = async (method, path, body, query = {}) => {
    const qs = new URLSearchParams(query).toString()
    const res = await fetch(`http://${emulator}/v1/${path}${qs ? '?' + qs : ''}`, {
      method, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`)
    return res.json()
  }
} else {
  const require = createRequire(import.meta.url)
  const root = require('node:path').join(require('node:child_process')
    .execFileSync('npm', ['root', '-g']).toString().trim(), 'firebase-tools/lib')
  const { requireAuth } = require(`${root}/requireAuth.js`)
  const { Client } = require(`${root}/apiv2.js`)
  const { firestoreOrigin } = require(`${root}/api.js`)
  const acct = require(`${root}/auth.js`).getGlobalDefaultAccount()
  if (!acct) throw new Error('The Firebase CLI is not signed in (run: npx firebase login)')
  await requireAuth({ project, projectId: project, user: acct.user, tokens: acct.tokens })
  const client = new Client({ urlPrefix: firestoreOrigin(), apiVersion: 'v1' })
  request = async (method, path, body, query = {}) =>
    (await client.request({ method, path: `/${path}`, body, queryParams: query, skipLog: { body: true, resBody: true } })).body
}

const fromValue = (v) => {
  if ('stringValue' in v) return v.stringValue
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('timestampValue' in v) return v.timestampValue
  if ('nullValue' in v) return null
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue)
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {})
  return undefined   // references, bytes, geo points: never used by the copies
}
const fromFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromValue(v)]))
const toValue = (v) => {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } }
  return { mapValue: { fields: toFields(v) } }
}
const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)]))

async function listAll(collection) {
  const out = []
  let pageToken
  do {
    const page = await request('GET', `${docsPath}/${collection}`, undefined, { pageSize: '300', ...(pageToken ? { pageToken } : {}) })
    for (const d of page.documents || []) out.push({ id: d.name.split('/').pop(), ...fromFields(d.fields) })
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

// ── Build the copies ─────────────────────────────────────────────────────────
const [users, customers, photos, profiles, logs] = await Promise.all(
  ['users', 'customers', 'customerPhotos', 'publicProfiles', 'photoLogs'].map(listAll))
const existing = (list) => new Map(list.map(({ id, updatedAt, ...rest }) => { void updatedAt; return [id, rest] }))
const haveProfile = existing(profiles)
const haveLog = existing(logs)

const writes = []
const counts = { profilesNew: 0, profilesChanged: 0, profilesCurrent: 0, logsNew: 0, logsChanged: 0, logsCurrent: 0 }
const stamp = new Date().toISOString()

for (const u of users) {
  const next = publicProfileFrom(u)
  const have = haveProfile.get(u.id)
  if (have && sameContent(have, next)) { counts.profilesCurrent++; continue }
  counts[have ? 'profilesChanged' : 'profilesNew']++
  writes.push({ path: `publicProfiles/${u.id}`, data: { ...next, updatedAt: stamp } })
}

// Photos are matched to a customer by id AND owner, the same pairing the app's
// own query makes (it reads only the contractor's own photos).
const photosByCustomer = new Map()
for (const p of photos) {
  if (!p.customerId || !p.createdBy) continue
  const key = `${p.createdBy}/${p.customerId}`
  photosByCustomer.set(key, [...(photosByCustomer.get(key) || []), p])
}
let customersWithoutOwner = 0
for (const c of customers) {
  if (!c.createdBy) { customersWithoutOwner++; continue }
  const list = photosByCustomer.get(`${c.createdBy}/${c.id}`)
  if (!list) continue
  const next = buildPhotoLog(c.createdBy, c, list)
  const have = haveLog.get(c.id)
  if (have && sameContent(have, next)) { counts.logsCurrent++; continue }
  counts[have ? 'logsChanged' : 'logsNew']++
  writes.push({ path: `photoLogs/${c.id}`, data: { ...next, updatedAt: stamp } })
}

console.log(`Project ${project}${emulator ? ` (emulator ${emulator})` : ''}: ${write ? 'PUBLISHING' : 'dry run, nothing written'}`)
console.log(`Read: ${users.length} contractor profiles, ${customers.length} customers, ${photos.length} photo records.`)
console.log(`Business cards: ${counts.profilesNew} to create, ${counts.profilesChanged} to update, ${counts.profilesCurrent} already current.`)
console.log(`Photo logs: ${counts.logsNew} to create, ${counts.logsChanged} to update, ${counts.logsCurrent} already current.`)
if (customersWithoutOwner) console.log(`Skipped ${customersWithoutOwner} customer records with no owner.`)

if (write && writes.length) {
  // Small batches: a photo log can hold hundreds of photo links.
  for (let i = 0; i < writes.length; i += 20) {
    await request('POST', `${docsPath}:commit`, {
      writes: writes.slice(i, i + 20).map(w => ({ update: { name: `${docsPath}/${w.path}`, fields: toFields(w.data) } })),
    })
  }
  console.log(`Published ${writes.length} copies.`)
}
