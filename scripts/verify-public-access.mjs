// What can a stranger on the internet read? Checks the live project the way a
// customer's browser (or anyone else) would: plain, signed-OUT requests to the
// Firestore web API. It looks up real document ids with the owner's CLI login
// first (never printed: an estimate id is a share link), then tries each read
// with no credentials at all.
//
// Read-only. Prints OPEN / CLOSED per check, never document contents.
//
//   node --experimental-strip-types scripts/verify-public-access.mjs --project contractors-office-96731 [--expect final|transition|stage1]
//
// --expect compares the result with what each rules stage should allow and
// exits 1 on any difference. Without it, it only reports.
import { connect, listRaw } from './lib/firestore-rest.mjs'
import { isCustomerSafeQuote } from '../src/lib/estimatePrivacy.ts'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const project = value('--project')
const expectStage = value('--expect')
if (!project) { console.error('Usage: --project <id> [--expect final|transition|stage1]'); process.exit(2) }
// The release rehearsal runs this same check against a local emulator copy,
// which must be a demo-* project so it can never be mistaken for the real one.
const emulator = process.env.FIRESTORE_EMULATOR_HOST
if (emulator && !project.startsWith('demo-')) { console.error('With FIRESTORE_EMULATOR_HOST set, use a demo-* project (or unset it to check the real project).'); process.exit(2) }

const conn = connect(project)
const base = emulator
  ? `http://${emulator}/v1/projects/${project}/databases/(default)/documents`
  : `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`
// No Authorization header: exactly what a signed-out visitor sends.
const anon = async (path, query = '') => {
  const res = await fetch(`${base}/${path}${query}`)
  let body = null
  try { body = await res.json() } catch { /* empty */ }
  return { status: res.status, body }
}
const first = async (c) => (await listRaw(conn, c))[0]

const results = []
const check = async (label, key, fn) => {
  try { results.push({ label, key, ...(await fn()) }) } catch (e) { results.push({ label, key, state: 'ERROR', note: e.message }) }
}
const openIf = (r) => ({ state: r.status === 200 ? 'OPEN' : r.status === 403 ? 'CLOSED' : `HTTP ${r.status}` })

for (const c of ['estimates', 'changeOrders', 'invoices', 'thankYouPackages', 'customers', 'customerPhotos', 'users', 'projects', 'estimatePrivate', 'publicProfiles', 'photoLogs']) {
  await check(`list ${c}`, `list:${c}`, async () => openIf(await anon(c, '?pageSize=1')))
}
const u = await first('users')
if (u) await check('get users/{id} (plan, Stripe ids)', 'get:users', async () => openIf(await anon(`users/${u.id}`)))
const cu = await first('customers')
if (cu) await check('get customers/{id} (phone, address, notes)', 'get:customers', async () => openIf(await anon(`customers/${cu.id}`)))
const pr = await first('projects')
if (pr) await check('get projects/{id}', 'get:projects', async () => openIf(await anon(`projects/${pr.id}`)))
const pp = await first('publicProfiles')
if (pp) await check('get publicProfiles/{id} (business card)', 'get:publicProfiles', async () => openIf(await anon(`publicProfiles/${pp.id}`)))
const pl = await first('photoLogs')
if (pl) await check('get photoLogs/{id} (published photo log)', 'get:photoLogs', async () => openIf(await anon(`photoLogs/${pl.id}`)))
const ep = await first('estimatePrivate')
if (ep) await check('get estimatePrivate/{id} (contractor notes)', 'get:estimatePrivate', async () => openIf(await anon(`estimatePrivate/${ep.id}`)))

// Estimates: the share link must open, and what it hands over must be
// customer-safe. Checks every estimate, reports only counts.
const ests = await listRaw(conn, 'estimates')
let opened = 0, leaking = 0, refused = 0
for (const e of ests) {
  const r = await anon(`estimates/${e.id}`)
  if (r.status !== 200) { refused++; continue }
  opened++
  const f = r.body?.fields || {}
  const q = f.aiQuote?.mapValue?.fields
  const pm = q?.profit_markup?.mapValue?.fields
  const quoteSafe = !q || isCustomerSafeQuote({
    contractor_notes: q.contractor_notes?.stringValue ?? '',
    profit_markup: {
      markup_dollars: Number(pm?.markup_dollars?.doubleValue ?? pm?.markup_dollars?.integerValue ?? 0),
      markup_percent: Number(pm?.markup_percent?.doubleValue ?? pm?.markup_percent?.integerValue ?? 0),
      rationale: pm?.rationale?.stringValue ?? '',
    },
  })
  const walkthrough = f.jobTypeId?.stringValue === 'quick-quote' && (f.description?.stringValue ?? '') !== ''
  if (!quoteSafe || walkthrough) leaking++
}
results.push({ label: `estimate share links open (${opened} of ${ests.length})`, key: 'get:estimates', state: refused ? `${refused} REFUSED` : 'OPEN' })
results.push({ label: 'estimates handing over private notes / markup / walkthrough', key: 'leak:estimates', state: leaking ? `${leaking} LEAKING` : 'none' })

// What each stage should show. "OPEN" = a share page needs it.
const expectations = {
  stage1: { 'get:users': 'OPEN', 'get:customers': 'OPEN', 'list:customerPhotos': 'OPEN' },
  transition: { 'get:users': 'OPEN', 'get:customers': 'OPEN', 'list:customerPhotos': 'OPEN', 'get:publicProfiles': 'OPEN', 'get:photoLogs': 'OPEN', 'get:estimatePrivate': 'CLOSED', 'leak:estimates': 'none' },
  final: { 'get:users': 'CLOSED', 'get:customers': 'CLOSED', 'list:customerPhotos': 'CLOSED', 'get:publicProfiles': 'OPEN', 'get:photoLogs': 'OPEN', 'get:estimatePrivate': 'CLOSED', 'leak:estimates': 'none' },
}
const always = {
  'list:estimates': 'CLOSED', 'list:changeOrders': 'CLOSED', 'list:invoices': 'CLOSED', 'list:thankYouPackages': 'CLOSED',
  'list:customers': 'CLOSED', 'list:users': 'CLOSED', 'list:projects': 'CLOSED', 'list:estimatePrivate': 'CLOSED',
  'list:publicProfiles': 'CLOSED', 'list:photoLogs': 'CLOSED', 'get:projects': 'CLOSED', 'get:estimates': 'OPEN',
}

console.log(`Signed-out access to ${project}${emulator ? ` (emulator ${emulator})` : ''}:`)
let mismatches = 0
for (const r of results) {
  const want = expectStage ? ({ ...always, ...(expectations[expectStage] || {}) })[r.key] : undefined
  const ok = want === undefined || r.state === want
  if (!ok) mismatches++
  console.log(`  ${ok ? ' ' : '✗'} ${r.label.padEnd(62)} ${r.state}${want && !ok ? `   (expected ${want})` : ''}${r.note ? `  ${r.note}` : ''}`)
}
if (expectStage) {
  console.log(mismatches ? `${mismatches} difference(s) from the ${expectStage} stage.` : `Matches the ${expectStage} stage.`)
  process.exit(mismatches ? 1 : 0)
}
