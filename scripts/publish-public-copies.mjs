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
import { connect, listAll as listAllIn, toFields } from './lib/firestore-rest.mjs'
import { buildPhotoLog, publicProfileFrom, sameContent } from '../src/lib/publicCopies.ts'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const project = value('--project')
const write = flag('--write')
if (!project) { console.error('Usage: --project <id> [--write]'); process.exit(2) }

const conn = connect(project)
const { request, docsPath, emulator } = conn
const listAll = (collection) => listAllIn(conn, collection)

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
