// Release rehearsal: the whole data side of the coordinated release (G3 to
// G7, then the 2.5 restore), played against a LOCAL emulator copy of the real
// database, with the real app pages a customer opens.
//
// Run with scripts/rehearsal/rehearse-release.sh <full backup.json>. The
// emulator project is demo-rehearsal; nothing here can reach the live project
// (the browser is held to this machine, the scripts refuse a non-demo project
// against the emulator).
//
// Prints counts and one-way tags only, never document contents. A page that
// reads differently is shown with every letter as "a" and digit as "9".
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'

const repo = resolve(import.meta.dirname, '../..')
const PROJECT = 'demo-rehearsal'
const EMU = '127.0.0.1:8580'
const BACKUP = process.env.REHEARSAL_BACKUP || ''
const OUT = process.env.REHEARSAL_OUT || '/tmp/bp-rehearsal'
const OLD = !!process.env.REHEARSAL_OLD_APP_DIR
const NEW_APP = 'http://127.0.0.1:5299'
const OLD_APP = 'http://127.0.0.1:5298'
const docsPath = `projects/${PROJECT}/databases/(default)/documents`
const docsBase = `http://${EMU}/v1/${docsPath}`

mkdirSync(OUT, { recursive: true })
const report = join(OUT, 'report.txt')
const log = (line: string) => { console.log(line); appendFileSync(report, line + '\n') }
const tag = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 10)
const mask = (s: string) => s.replace(/[A-Za-z]/g, 'a').replace(/[0-9]/g, '9')

// ── Helpers ─────────────────────────────────────────────────────────────────
function script(name: string, args: string[]): { code: number; out: string } {
  const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', `scripts/${name}`, '--project', PROJECT, ...args], {
    cwd: repo, env: { ...process.env, FIRESTORE_EMULATOR_HOST: EMU }, encoding: 'utf8',
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}
const showScript = (label: string, r: { code: number; out: string }) => {
  log(`  [${label}] exit ${r.code}`)
  for (const line of r.out.trim().split('\n')) log(`    ${line.replace(/\/[^\s]*buildpro-rehearsal[^\s]*/g, '<rehearsal file>')}`)
}

async function setRules(content: string) {
  const r = await fetch(`http://${EMU}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content }] } }),
  })
  expect(r.ok, `rules load: HTTP ${r.status} ${await r.text()}`).toBe(true)
}
const stage1Rules = execFileSync('git', ['show', 'rules/stage1-urgent:firestore.rules'], { cwd: repo, encoding: 'utf8' })
const transitionRules = readFileSync(join(repo, 'firestore.transition.rules'), 'utf8')
const finalRules = readFileSync(join(repo, 'firestore.rules'), 'utf8')

// Canonical JSON (sorted keys) so field order never counts as a difference.
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
type RawDoc = { name: string; fields: Record<string, unknown>; updateTime?: string }
const rel = (name: string) => name.slice(name.indexOf('/documents/') + '/documents/'.length)
const top = (d: RawDoc) => rel(d.name).split('/')
const plain = (v: unknown): unknown => {
  const x = v as Record<string, unknown>
  if ('stringValue' in x) return x.stringValue
  if ('integerValue' in x) return Number(x.integerValue)
  if ('doubleValue' in x) return x.doubleValue
  if ('booleanValue' in x) return x.booleanValue
  if ('nullValue' in x) return null
  if ('timestampValue' in x) return x.timestampValue
  if ('mapValue' in x) return Object.fromEntries(Object.entries(((x.mapValue as { fields?: object }).fields || {})).map(([k, y]) => [k, plain(y)]))
  if ('arrayValue' in x) return (((x.arrayValue as { values?: unknown[] }).values) || []).map(plain)
  return undefined
}
const field = (d: RawDoc, k: string) => (k in d.fields ? plain(d.fields[k]) : undefined)

async function listEmu(collection: string): Promise<RawDoc[]> {
  const out: RawDoc[] = []
  let pageToken = ''
  do {
    const r = await fetch(`${docsBase}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: { Authorization: 'Bearer owner' } })
    const j = await r.json() as { documents?: RawDoc[]; nextPageToken?: string }
    out.push(...(j.documents || []))
    pageToken = j.nextPageToken || ''
  } while (pageToken)
  return out
}

// A signed-in user as the emulator sees one (it accepts unsigned tokens).
const tokenFor = (uid: string) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid,
    iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom', identities: {} },
  })}.`
}
const getAs = async (uid: string | null, path: string) =>
  (await fetch(`${docsBase}/${path}`, { headers: uid ? { Authorization: `Bearer ${tokenFor(uid)}` } : {} })).status

// ── The real data ───────────────────────────────────────────────────────────
const backup = JSON.parse(readFileSync(BACKUP, 'utf8')) as { project: string; documents: RawDoc[] }
const ofColl = (c: string) => backup.documents.filter(d => top(d).length === 2 && top(d)[0] === c)
const idOf = (d: RawDoc) => top(d)[1]
const originalEstimates = new Map(ofColl('estimates').map(d => [idOf(d), d]))
const logCustomers = [...new Set(ofColl('customerPhotos').map(d => field(d, 'customerId')).filter((x): x is string => typeof x === 'string'))]
const links: string[] = [
  ...ofColl('estimates').map(d => `/q/${idOf(d)}`),
  ...ofColl('changeOrders').map(d => `/co/${idOf(d)}`),
  ...ofColl('invoices').map(d => `/inv/${idOf(d)}`),
  ...ofColl('thankYouPackages').map(d => `/thanks/${idOf(d)}`),
  ...logCustomers.map(id => `/log/${id}`),
]
const linkLabel = (l: string) => `${l.split('/')[1]} #${tag(l.split('/')[2])}`

// ── Reading share pages the way a customer does ─────────────────────────────
async function settle(p: Page, url: string, navTimeout = 90_000): Promise<string> {
  // Never let an error message carry the URL (an estimate id is a share link).
  try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout }) } catch { return '[NAVIGATION FAILED]' }
  let last = '', same = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000) {
    await p.waitForTimeout(400)
    const t = (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
    const loading = t.length < 300 && /loading/i.test(t)
    if (t && t === last && !loading) { if (++same >= 4) return t } else { same = 0; last = t }
  }
  return `${last} [NOT SETTLED]`
}

async function capture(browser: Browser, base: string, subset: string[] = links): Promise<Map<string, string>> {
  const ctx = await browser.newContext()
  // Only this machine: no real photo, logo or font request leaves it. (Local
  // requests are not intercepted at all, so the database connection streams
  // normally.)
  await ctx.route(url => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', route => route.abort())
  // Warm up first: a cold dev server can take longer than the database
  // client's 10-second "offline" limit on the very first pages.
  const warm = await ctx.newPage()
  await settle(warm, `${base}${links[0]}`, 180_000)
  await warm.close()
  const queue = [...subset]
  const out = new Map<string, string>()
  const tabs = await Promise.all([0, 1].map(() => ctx.newPage()))
  await Promise.all(tabs.map(async t => {
    for (let l = queue.shift(); l; l = queue.shift()) {
      // A page that could not load is tried twice more: a real refusal by
      // the rules fails every time and is still caught; a slow machine is not.
      let text = await settle(t, base + l)
      for (let i = 0; i < 2 && LOAD_ERROR.test(text); i++) text = await settle(t, base + l)
      out.set(l, text)
    }
  }))
  await ctx.close()
  return out
}
const LOAD_ERROR = /Could not load|Taking longer than expected|\[NOT SETTLED\]|\[NAVIGATION FAILED\]/

// The first page a dev server serves compiles the app (minutes on a busy
// machine); do that for each app before anything is measured.
async function warmUp(browser: Browser, base: string) {
  const ctx = await browser.newContext()
  await ctx.route(url => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', route => route.abort())
  const p = await ctx.newPage()
  await p.goto(`${base}/`, { waitUntil: 'load', timeout: 300_000 }).catch(() => {})
  await settle(p, `${base}${links[0]}`, 300_000)
  await ctx.close()
}

// A reference reading: two full passes, and any page the passes disagree on
// is read again until one version has shown up twice (a business card that
// arrived late on a busy machine is not the reference).
async function captureReference(browser: Browser, base: string): Promise<Map<string, string>> {
  const a = await capture(browser, base)
  const b = await capture(browser, base)
  const seen = new Map([...a.keys()].filter(k => a.get(k) !== b.get(k)).map(k => [k, [a.get(k)!, b.get(k)!]]))
  const settled = (k: string) => { const v = seen.get(k)!; return v.filter(x => x === v[v.length - 1]).length >= 2 }
  for (let round = 0; round < 3; round++) {
    const open = [...seen.keys()].filter(k => !settled(k))
    if (!open.length) break
    const c = await capture(browser, base, open)
    for (const k of open) seen.get(k)!.push(c.get(k)!)
  }
  const out = new Map(a)
  for (const [k, v] of seen) out.set(k, v[v.length - 1])
  const never = [...seen.keys()].filter(k => !settled(k)).length
  log(`  (reference reading: ${seen.size} page(s) read differently between passes and were re-read${never ? `; ${never} never read the same twice` : ''})`)
  return out
}

// Read every page; one that differs from the reference is read twice more
// before it counts as different.
async function check(label: string, want: Map<string, string>, browser: Browser, base: string, mustMatch: boolean): Promise<number> {
  const got = await capture(browser, base)
  let diffs = [...want.keys()].filter(k => want.get(k) !== got.get(k))
  for (let round = 0; round < 2 && diffs.length; round++) {
    const again = await capture(browser, base, diffs)
    for (const k of diffs) got.set(k, again.get(k)!)
    diffs = diffs.filter(k => want.get(k) !== got.get(k))
  }
  return compare(label, want, got, mustMatch)
}

function compare(label: string, want: Map<string, string>, got: Map<string, string>, mustMatch: boolean): number {
  const diffs = [...want.keys()].filter(k => want.get(k) !== got.get(k))
  log(`${diffs.length ? (mustMatch ? '✗' : '•') : '✓'} ${label}: ${want.size - diffs.length} of ${want.size} share pages read word-for-word the same`)
  for (const k of diffs) {
    const a = want.get(k) || '', b = got.get(k) || ''
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    log(`    ${linkLabel(k)} differs at char ${i}: "${mask(a.slice(Math.max(0, i - 20), i + 60))}" → "${mask(b.slice(Math.max(0, i - 20), i + 60))}"${b.includes('[NOT SETTLED]') ? ' (page never finished loading)' : ''}`)
  }
  return diffs.length
}
const notSettled = (m: Map<string, string>) => [...m.values()].filter(v => v.endsWith('[NOT SETTLED]')).length

// ── The rehearsal ───────────────────────────────────────────────────────────
test('coordinated release, rehearsed on a copy of production data', async ({ browser }) => {
  expect(BACKUP, 'REHEARSAL_BACKUP must point at a full backup (scripts/backup-firestore.mjs)').not.toBe('')
  log(`Release rehearsal ${new Date().toISOString()} — backup of ${backup.project}, ${backup.documents.length} documents; ${links.length} share links; old app ${OLD ? 'included' : 'not included'}`)
  let failures = 0
  const must = (ok: boolean, what: string) => { log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures++ }
  await warmUp(browser, NEW_APP)
  if (OLD) await warmUp(browser, OLD_APP)

  // ── 0. Today: stage-1 rules, data as it is in production ──
  log('\n== Today (stage-1 rules, data as in production)')
  await fetch(`http://${EMU}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await setRules(stage1Rules)
  const load = script('backup-firestore.mjs', ['--restore', BACKUP, '--write'])
  showScript('restore full backup into the emulator', load)
  must(load.code === 0, 'full backup restored (the disaster-recovery path)')

  // The restore is exact: back it up again from the emulator and compare.
  const emuDir = join(OUT, 'buildpro-rehearsal-emulator-backup')
  const again = script('backup-firestore.mjs', ['--out', emuDir])
  must(again.code === 0, 'emulator copy backed up again')
  const emuFile = readdirSync(emuDir).filter(f => f.endsWith('.json')).sort().pop()!
  const emuDocs = new Map((JSON.parse(readFileSync(join(emuDir, emuFile), 'utf8')).documents as RawDoc[]).map(d => [rel(d.name), d]))
  const mismatched = backup.documents.filter(d => !emuDocs.has(rel(d.name)) || canon(emuDocs.get(rel(d.name))!.fields) !== canon(d.fields)).length
  must(mismatched === 0 && emuDocs.size === backup.documents.length, `restored copy identical to production backup: ${backup.documents.length - mismatched} of ${backup.documents.length} documents (emulator holds ${emuDocs.size})`)

  const s1 = script('verify-public-access.mjs', ['--expect', 'stage1'])
  showScript('signed-out access, expect stage1', s1)
  must(s1.code === 0, 'access matches the stage-1 rules live today (incl. the leaks this release closes)')

  // What customers see today: the app live today, on the stage-1 rules.
  let A_old: Map<string, string> | undefined
  if (OLD) {
    A_old = await captureReference(browser, OLD_APP)
    must(notSettled(A_old) === 0, `today (app live today): all ${A_old.size} share pages load (${notSettled(A_old)} did not)`)
  }

  // ── G3: transition rules (the app live today keeps running until G5) ──
  log('\n== G3 transition rules, before the data steps')
  await setRules(transitionRules)
  const t1 = script('verify-public-access.mjs', [])
  showScript('signed-out access', t1)
  must(new RegExp(`estimate share links open \\(${originalEstimates.size} of ${originalEstimates.size}\\)\\s+OPEN`).test(t1.out), 'every estimate link still opens')
  if (OLD && A_old) failures += await check('G3→G5 window: app live today on the transition rules vs today', A_old, browser, OLD_APP, true)

  // ── G5: the new app goes live (on the transition rules, never on stage 1) ──
  log('\n== G5 new app live, before the data steps')
  const A_new = await captureReference(browser, NEW_APP)
  must(notSettled(A_new) === 0, `new app: all ${A_new.size} share pages load (${notSettled(A_new)} did not)`)
  if (OLD && A_old) compare('for information, what the G5 switch changes on customer pages: app live today vs new app', A_old, A_new, false)

  // ── G6: customer-safe copies, then the estimate cleanup ──
  log('\n== G6 data steps (2.4 copies, 2.5 estimate cleanup)')
  const pubW = script('publish-public-copies.mjs', ['--write']); showScript('2.4 --write', pubW)
  must(pubW.code === 0, '2.4 wrote the copies')
  const pubD = script('publish-public-copies.mjs', []); showScript('2.4 dry run again', pubD)
  must(/Business cards: 0 to create, 0 to update/.test(pubD.out) && /Photo logs: 0 to create, 0 to update/.test(pubD.out), '2.4 second dry run: 0 to create, 0 to update (the G7 precondition)')

  const migDir = join(OUT, 'buildpro-rehearsal-migrate-backup')
  const migW = script('migrate-estimate-privacy.mjs', ['--write', '--backup-dir', migDir]); showScript('2.5 --write', migW)
  must(migW.code === 0 && /Cleaned \d+; not cleaned 0\./.test(migW.out), '2.5 cleaned every estimate it planned to, none refused')
  const migD = script('migrate-estimate-privacy.mjs', []); showScript('2.5 dry run again', migD)
  must(/To clean: 0 /.test(migD.out) && /Failures \(left exactly as they are\): 0\./.test(migD.out), '2.5 second dry run: To clean 0, Failures 0')
  const migBackup = join(migDir, readdirSync(migDir).filter(f => f.startsWith('estimate-privacy-')).sort().pop()!)

  // What the cleanup did, document by document, against the original.
  const cleaned = await listEmu('estimates')
  const privates = new Map((await listEmu('estimatePrivate')).map(d => [rel(d.name).split('/')[1], d]))
  const moved = new Set(['aiQuote', 'laborTotal', 'materialsTotal', 'rentalsTotal', 'description'])
  let untouchedOk = 0, signedOk = 0, signedCount = 0, notesOk = 0, notesWant = 0, narrationOk = 0, narrationWant = 0, markupOk = 0, markupWant = 0
  for (const d of cleaned) {
    const id = rel(d.name).split('/')[1]
    const o = originalEstimates.get(id)!
    const keys = new Set([...Object.keys(o.fields), ...Object.keys(d.fields)])
    const otherSame = [...keys].filter(k => !moved.has(k)).every(k => canon(o.fields[k]) === canon(d.fields[k]))
    if (otherSame) untouchedOk++
    if (field(o, 'status') === 'approved') {
      signedCount++
      if (otherSame && ['customerResponse', 'signedAtMs', 'total', 'status', 'createdAt', 'proposal', 'scopeOfWork'].every(k => canon(o.fields[k]) === canon(d.fields[k]))) signedOk++
    }
    const q = field(o, 'aiQuote') as { contractor_notes?: string; profit_markup?: { markup_dollars?: number } } | undefined
    const p = privates.get(id)
    const notes = (q?.contractor_notes || '').trim()
    if (notes) { notesWant++; if (p && field(p, 'contractorNotes') === notes) notesOk++ }
    const narration = field(o, 'jobTypeId') === 'quick-quote' ? String(field(o, 'description') || '').trim() : ''
    if (narration) { narrationWant++; if (p && field(p, 'narration') === narration) narrationOk++ }
    const md = Number(q?.profit_markup?.markup_dollars) || 0
    if (md) { markupWant++; if (p && field(p, 'aiMarkupDollars') === md) markupOk++ }
  }
  must(untouchedOk === cleaned.length, `every field other than the moved ones is byte-identical: ${untouchedOk} of ${cleaned.length} estimates`)
  must(signedOk === signedCount, `signed estimates: signature, signing time, total, status, date, letter and scope identical on ${signedOk} of ${signedCount}`)
  must(notesOk === notesWant && narrationOk === narrationWant && markupOk === markupWant,
    `private side kept word-for-word in estimatePrivate: notes ${notesOk}/${notesWant}, walkthroughs ${narrationOk}/${narrationWant}, markup figures ${markupOk}/${markupWant}`)

  const t2 = script('verify-public-access.mjs', ['--expect', 'transition']); showScript('signed-out access, expect transition', t2)
  must(t2.code === 0, 'access matches the transition stage (no estimate hands over private parts)')
  failures += await check('after G6: new app vs right after G5', A_new, browser, NEW_APP, true)
  if (OLD && A_old) failures += await check('rollback check: app live today on cleaned data (hosting rolled back after G6) vs today', A_old, browser, OLD_APP, true)

  // ── G7: final rules ──
  log('\n== G7 final rules')
  await setRules(finalRules)
  const f1 = script('verify-public-access.mjs', ['--expect', 'final']); showScript('signed-out access, expect final', f1)
  must(f1.code === 0, 'access matches the final stage: customers, billing profiles and the photo list closed; no private estimate parts')
  failures += await check('after G7: new app vs right after G5', A_new, browser, NEW_APP, true)
  if (OLD && A_old) await check('for information (why hosting must be rolled back before rules): app live today under the final rules vs today', A_old, browser, OLD_APP, false)

  // Signed in as one real contractor, reaching for another's records.
  const owners = new Map<string, string>()   // path -> owner uid
  for (const c of ['customers', 'customerPhotos', 'projects']) for (const d of ofColl(c)) { const u = field(d, 'createdBy'); if (typeof u === 'string') owners.set(`${c}/${idOf(d)}`, u) }
  for (const d of ofColl('users')) owners.set(`users/${idOf(d)}`, idOf(d))
  for (const [id, p] of privates) { const u = field(p, 'createdBy'); if (typeof u === 'string') owners.set(`estimatePrivate/${id}`, u) }
  const uids = [...new Set(owners.values())]
  let tried = 0, allowed = 0, ownTried = 0, ownOk = 0
  for (const uid of uids) {
    for (const [path, owner] of owners) {
      const status = await getAs(uid, path)
      if (owner === uid) { ownTried++; if (status === 200) ownOk++ } else { tried++; if (status !== 403) allowed++ }
    }
  }
  must(ownOk === ownTried && ownTried > 0, `each contractor still opens their own records (control): ${ownOk} of ${ownTried}`)
  must(allowed === 0 && tried > 0, `another signed-in contractor is refused: ${tried - allowed} of ${tried} attempts on customers, photos, projects, billing profiles and estimate notes`)
  let strangerAllowed = 0
  for (const path of owners.keys()) if ((await getAs(null, path)) !== 403) strangerAllowed++
  must(strangerAllowed === 0, `signed-out visitor refused on all ${owners.size} of those records`)

  // ── Restore drill (2.5 rollback), then clean again ──
  log('\n== 2.5 restore drill')
  const rs = script('migrate-estimate-privacy.mjs', ['--restore', migBackup, '--write']); showScript('2.5 --restore --write', rs)
  must(rs.code === 0, 'restore ran without failures')
  const restored = await listEmu('estimates')
  let exact = 0, signedExact = 0
  for (const d of restored) {
    const o = originalEstimates.get(rel(d.name).split('/')[1])!
    if (canon(o.fields) === canon(d.fields)) { exact++; if (field(o, 'status') === 'approved') signedExact++ }
  }
  must(exact === originalEstimates.size, `restored estimates identical to production, every field: ${exact} of ${originalEstimates.size} (signed: ${signedExact} of ${signedCount})`)
  failures += await check('after restore: new app vs right after G5', A_new, browser, NEW_APP, true)
  const r1 = script('verify-public-access.mjs', []); showScript('signed-out access after restore (leaks back, as expected)', r1)

  const again2 = script('migrate-estimate-privacy.mjs', ['--write', '--backup-dir', join(OUT, 'buildpro-rehearsal-migrate-backup-2')]); showScript('2.5 again after restore', again2)
  const f2 = script('verify-public-access.mjs', ['--expect', 'final']); showScript('signed-out access, expect final', f2)
  must(again2.code === 0 && f2.code === 0, 'cleaning again after a restore works and the final stage matches again')

  log(`\n${failures ? `REHEARSAL FAILED: ${failures} check(s)` : 'REHEARSAL PASSED: every check above held'}`)
  expect(failures).toBe(0)
})
