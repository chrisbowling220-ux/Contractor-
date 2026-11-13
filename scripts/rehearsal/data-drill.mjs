// The data half of the release rehearsal, without browsers (for a machine too
// short on memory for release-rehearsal.spec.ts): a production backup loaded
// into a local emulator, then G3 → G6 (2.4, 2.5) → G7 → 2.5 restore → clean
// again, with the real scripts, the real rules, and signed-in / signed-out
// probes on the real records. Nothing here talks to the live project.
//
//   npx firebase emulators:exec --config scripts/rehearsal/firebase.rehearsal.json \
//     --only firestore --project demo-rehearsal \
//     "node scripts/rehearsal/data-drill.mjs ~/buildpro-backups/firestore-….json.gpg"
//
// Prints counts and pass/fail only, never document contents or ids. Its own
// copies of real data (2.5 backups) are encrypted and deleted at the end.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readBackupFile } from '../lib/backup-crypto.mjs'

const repo = resolve(import.meta.dirname, '../..')
const PROJECT = 'demo-rehearsal'
const EMU = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8580'
const BACKUP = process.argv[2]
if (!BACKUP) { console.error('Usage: node scripts/rehearsal/data-drill.mjs <full backup .json[.gpg]>'); process.exit(2) }
const docsBase = `http://${EMU}/v1/projects/${PROJECT}/databases/(default)/documents`
const work = mkdtempSync(join(tmpdir(), 'bp-data-drill-'))

let failures = 0
const must = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures++ }
const script = (name, args) => {
  const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', `scripts/${name}`, '--project', PROJECT, ...args], {
    cwd: repo, env: { ...process.env, FIRESTORE_EMULATOR_HOST: EMU }, encoding: 'utf8',
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}
const setRules = async (content) => {
  const r = await fetch(`http://${EMU}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  })
  if (!r.ok) throw new Error(`rules load: HTTP ${r.status}`)
}
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v)
const rel = (name) => name.slice(name.indexOf('/documents/') + '/documents/'.length)
const plain = (x) => {
  if ('stringValue' in x) return x.stringValue
  if ('integerValue' in x) return Number(x.integerValue)
  if ('doubleValue' in x) return x.doubleValue
  if ('booleanValue' in x) return x.booleanValue
  if ('nullValue' in x) return null
  if ('timestampValue' in x) return x.timestampValue
  if ('mapValue' in x) return Object.fromEntries(Object.entries(x.mapValue.fields || {}).map(([k, y]) => [k, plain(y)]))
  if ('arrayValue' in x) return (x.arrayValue.values || []).map(plain)
  return undefined
}
const field = (d, k) => (k in d.fields ? plain(d.fields[k]) : undefined)
async function listEmu(collection) {
  const out = []
  let pageToken = ''
  do {
    const r = await fetch(`${docsBase}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: { Authorization: 'Bearer owner' } })
    const j = await r.json()
    out.push(...(j.documents || []))
    pageToken = j.nextPageToken || ''
  } while (pageToken)
  return out
}
const tokenFor = (uid) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid,
    iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom', identities: {} },
  })}.`
}
const getAs = async (uid, path) => (await fetch(`${docsBase}/${path}`, { headers: uid ? { Authorization: `Bearer ${tokenFor(uid)}` } : {} })).status

const backup = JSON.parse(readBackupFile(BACKUP))
const top = (d) => rel(d.name).split('/')
const ofColl = (c) => backup.documents.filter(d => top(d).length === 2 && top(d)[0] === c)
const original = new Map(ofColl('estimates').map(d => [top(d)[1], d]))
const signedIds = [...original].filter(([, d]) => field(d, 'status') === 'approved').map(([id]) => id)

try {
  console.log(`Data drill ${new Date().toISOString()}: backup of ${backup.project}, ${backup.documents.length} documents, ${original.size} estimates (${signedIds.length} signed)`)
  const stage1 = execFileSync('git', ['show', 'rules/stage1-urgent:firestore.rules'], { cwd: repo, encoding: 'utf8' })
  await fetch(`http://${EMU}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await setRules(stage1)
  const load = script('backup-firestore.mjs', ['--restore', BACKUP, '--write'])
  must(load.code === 0 && new RegExp(`Restored ${backup.documents.length}, failed 0`).test(load.out), `full (encrypted) backup restored into the emulator: ${backup.documents.length} documents`)
  must(script('verify-public-access.mjs', ['--expect', 'stage1']).code === 0, 'signed-out access matches the stage-1 rules live today')

  await setRules(readFileSync(join(repo, 'firestore.transition.rules'), 'utf8'))
  must(script('publish-public-copies.mjs', ['--write']).code === 0, 'G6 2.4 wrote the copies')
  const pubD = script('publish-public-copies.mjs', [])
  must(/Business cards: 0 to create, 0 to update/.test(pubD.out) && /Photo logs: 0 to create, 0 to update/.test(pubD.out), '2.4 second dry run: 0 to create, 0 to update')
  const migDir = join(work, 'migrate-1')
  const migW = script('migrate-estimate-privacy.mjs', ['--write', '--backup-dir', migDir])
  must(migW.code === 0 && /Cleaned \d+; not cleaned 0\./.test(migW.out), `2.5 cleaned every estimate it planned to (${(/To clean: (\d+)/.exec(migW.out) || [])[1]}), none refused`)
  console.log(`  ${(/printed prices: .*/.exec(migW.out) || [''])[0]}`)
  const migFile = readdirSync(migDir).find(f => f.startsWith('estimate-privacy-'))
  must(!!migFile && migFile.endsWith('.json.gpg'), '2.5 wrote its own backup encrypted (.json.gpg)')
  const migD = script('migrate-estimate-privacy.mjs', [])
  must(/To clean: 0 /.test(migD.out) && /Failures \(left exactly as they are\): 0\./.test(migD.out), '2.5 second dry run: To clean 0, Failures 0')

  const cleaned = await listEmu('estimates')
  const moved = new Set(['aiQuote', 'laborTotal', 'materialsTotal', 'rentalsTotal', 'description', 'hourlyRate'])
  let otherSame = 0, signedCore = 0, rateChanged = 0, totalsSame = 0
  for (const d of cleaned) {
    const o = original.get(top(d)[1])
    const keys = new Set([...Object.keys(o.fields), ...Object.keys(d.fields)])
    if ([...keys].filter(k => !moved.has(k)).every(k => canon(o.fields[k]) === canon(d.fields[k]))) otherSame++
    if (field(o, 'status') === 'approved' && ['customerResponse', 'signedAtMs', 'total', 'status', 'createdAt', 'proposal', 'scopeOfWork', 'hourlyRate'].every(k => canon(o.fields[k]) === canon(d.fields[k]))) signedCore++
    if (canon(o.fields.hourlyRate) !== canon(d.fields.hourlyRate)) rateChanged++
    if (canon(o.fields.total) === canon(d.fields.total) && field(o, 'aiQuote')?.final_customer_quote === field(d, 'aiQuote')?.final_customer_quote) totalsSame++
  }
  must(otherSame === cleaned.length, `every field outside the moved ones byte-identical: ${otherSame} of ${cleaned.length}`)
  must(signedCore === signedIds.length, `signed: signature, signing time, total, status, date, letter, scope and rate identical on ${signedCore} of ${signedIds.length}`)
  must(totalsSame === cleaned.length, `totals (estimate and quote) unchanged on ${totalsSame} of ${cleaned.length}`)
  must(rateChanged === Number((/labor-only hourly rate folded in: (\d+)/.exec(migW.out) || [])[1]), `hourly rate changed only where 2.5 planned the labor-only fold: ${rateChanged}`)
  must(script('verify-public-access.mjs', ['--expect', 'transition']).code === 0, 'signed-out access matches the transition stage')

  await setRules(readFileSync(join(repo, 'firestore.rules'), 'utf8'))
  must(script('verify-public-access.mjs', ['--expect', 'final']).code === 0, 'G7: signed-out access matches the final stage')
  const owners = new Map()
  for (const c of ['customers', 'customerPhotos', 'projects', 'propertyAdvisorSessions']) for (const d of ofColl(c)) { const u = field(d, 'createdBy'); if (typeof u === 'string') owners.set(`${c}/${top(d)[1]}`, u) }
  for (const d of ofColl('users')) owners.set(`users/${top(d)[1]}`, top(d)[1])
  for (const d of await listEmu('estimatePrivate')) { const u = field(d, 'createdBy'); if (typeof u === 'string') owners.set(`estimatePrivate/${top(d)[1]}`, u) }
  const uids = [...new Set(owners.values())]
  let tried = 0, allowed = 0, ownTried = 0, ownOk = 0, strangerAllowed = 0
  for (const uid of uids) for (const [path, owner] of owners) {
    const status = await getAs(uid, path)
    if (owner === uid) { ownTried++; if (status === 200) ownOk++ } else { tried++; if (status !== 403) allowed++ }
  }
  for (const path of owners.keys()) if ((await getAs(null, path)) !== 403) strangerAllowed++
  must(ownOk === ownTried && ownTried > 0, `each contractor opens their own records: ${ownOk} of ${ownTried}`)
  must(allowed === 0 && tried > 0, `another signed-in contractor refused: ${tried - allowed} of ${tried} (customers, photos, projects, property-advisor sessions, billing profiles, estimate notes)`)
  must(strangerAllowed === 0, `signed-out visitor refused on all ${owners.size} of those records`)

  const rs = script('migrate-estimate-privacy.mjs', ['--restore', join(migDir, migFile), '--write'])
  must(rs.code === 0 && /failed 0\./.test(rs.out), '2.5 restore from its encrypted backup ran without failures')
  let exact = 0, signedExact = 0
  for (const d of await listEmu('estimates')) {
    const o = original.get(top(d)[1])
    if (canon(o.fields) === canon(d.fields)) { exact++; if (field(o, 'status') === 'approved') signedExact++ }
  }
  must(exact === original.size, `restored estimates identical to production in every field: ${exact} of ${original.size} (signed ${signedExact} of ${signedIds.length})`)
  const again = script('migrate-estimate-privacy.mjs', ['--write', '--backup-dir', join(work, 'migrate-2')])
  must(again.code === 0 && script('verify-public-access.mjs', ['--expect', 'final']).code === 0, 'cleaning again after the restore works; final stage matches again')

  console.log(`\n${failures ? `DATA DRILL FAILED: ${failures} check(s)` : 'DATA DRILL PASSED: every check above held'}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
