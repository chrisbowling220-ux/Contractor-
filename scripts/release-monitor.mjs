// Release monitor: what is live, and is anything going wrong? Read-only.
//
//   node scripts/release-monitor.mjs --project contractors-office-96731            one report
//   node scripts/release-monitor.mjs --project contractors-office-96731 --watch 120 every 2 min
//   ... --since 2026-11-12T23:00:00Z    count errors and refusals from this time (default: 60 min ago)
//   ... --details                       also print the first line of each error message
//
// Each report shows:
//   - the site answering, and which build it serves (compared with dist/ here);
//   - the live Hosting version, the live Firestore and Storage rules and which
//     release stage they are (stage 1 / transition / final), and the functions;
//   - function errors in the logs since --since (count per function);
//   - Firestore rule evaluations allowed / refused per 10 minutes (a jump in
//     refusals right after a rules deploy means real users are being refused).
//     Cloud Monitoring lags 3-5 minutes; the newest bucket fills in late.
// Never prints document contents; error text only with --details.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const project = value('--project')
const watch = Number(value('--watch') || 0)
const details = args.includes('--details')
const since = value('--since') ? new Date(value('--since')) : new Date(Date.now() - 60 * 60e3)
const site = value('--site') || 'https://builderspro.cc'
if (!project || Number.isNaN(since.getTime())) { console.error('Usage: --project <id> [--watch <seconds>] [--since <ISO time>] [--details] [--site <url>]'); process.exit(2) }

const require = createRequire(import.meta.url)
const root = join(execFileSync('npm', ['root', '-g']).toString().trim(), 'firebase-tools/lib')
const { requireAuth } = require(`${root}/requireAuth.js`)
const { Client } = require(`${root}/apiv2.js`)
const api = require(`${root}/api.js`)
const acct = require(`${root}/auth.js`).getGlobalDefaultAccount()
if (!acct) throw new Error('The Firebase CLI is not signed in (run: npx firebase login)')
await requireAuth({ project, projectId: project, user: acct.user, tokens: acct.tokens })
const call = async (origin, version, method, path, { query, body } = {}) =>
  (await new Client({ urlPrefix: origin, apiVersion: version }).request({ method, path, queryParams: query, body, skipLog: { body: true, resBody: true } })).body

const norm = (s) => (s || '').replace(/\r\n/g, '\n').trim()
const gitShow = (ref, path) => { try { return execFileSync('git', ['show', `${ref}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch { return null } }
const fileOr = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
const firestoreStages = [
  ['STAGE 1 (live before this release)', gitShow('rules/stage1-urgent', 'firestore.rules')],
  ['TRANSITION (step 2.1)', fileOr('firestore.transition.rules')],
  ['FINAL (step 3)', fileOr('firestore.rules')],
]
const storageStages = [
  ['before this release', gitShow('checkpoint/pre-audit-2026-11-10', 'storage.rules')],
  ['this release', fileOr('storage.rules')],
]
const stageOf = (src, stages) => stages.find(([, s]) => s !== null && norm(s) === norm(src))?.[0] || 'UNKNOWN (matches no rules file here)'
// The entry script the page loads (its name changes with every build).
const assetOf = (html) => (html.match(/<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/) || [])[1] || null

async function report() {
  const lines = [`── ${new Date().toISOString()}  ${project}`]
  const add = (s) => lines.push(`  ${s}`)

  // Site
  try {
    const res = await fetch(`${site}/?monitor=${Date.now()}`, { redirect: 'follow' })
    const html = await res.text()
    const liveAsset = assetOf(html)
    const localAsset = existsSync('dist/index.html') ? assetOf(readFileSync('dist/index.html', 'utf8')) : null
    const shareRes = await fetch(`${site}/q/monitor-check`)
    add(`Site: HTTP ${res.status}; serves ${liveAsset || '?'}${localAsset ? (liveAsset === localAsset ? ' = this dist/ build' : ` (dist/ here is ${localAsset})`) : ''}; share-link route HTTP ${shareRes.status}`)
  } catch (e) { add(`Site: NOT REACHABLE (${e.message})`) }

  // Hosting, rules, functions
  try {
    const live = await call(api.hostingApiOrigin(), 'v1beta1', 'GET', `/projects/-/sites/${project}/channels/live`)
    add(`Hosting: version ${live.release?.version?.name?.split('/').pop()} released ${live.release?.releaseTime}`)
  } catch (e) { add(`Hosting: could not read (${e.message})`) }
  try {
    const releases = (await call(api.rulesOrigin(), 'v1', 'GET', `/projects/${project}/releases`)).releases || []
    for (const rel of releases) {
      const kind = rel.name.includes('cloud.firestore') ? 'Firestore' : rel.name.includes('firebase.storage') ? 'Storage' : null
      if (!kind) continue
      const rs = await call(api.rulesOrigin(), 'v1', 'GET', `/projects/${project}/rulesets/${rel.rulesetName.split('/').pop()}`)
      const src = rs.source?.files?.map(f => f.content).join('\n') || ''
      add(`${kind} rules: ${stageOf(src, kind === 'Firestore' ? firestoreStages : storageStages)} — ruleset ${rel.rulesetName.split('/').pop().slice(0, 8)}, since ${rel.updateTime}`)
    }
  } catch (e) { add(`Rules: could not read (${e.message})`) }
  try {
    const fns = (await call(api.functionsV2Origin(), 'v2', 'GET', `/projects/${project}/locations/-/functions`, { query: { pageSize: '200' } })).functions || []
    const notActive = fns.filter(f => f.state !== 'ACTIVE').map(f => `${f.name.split('/').pop()}=${f.state}`)
    const newest = fns.map(f => f.updateTime).sort().pop()
    add(`Functions: ${fns.length} deployed, ${notActive.length ? `NOT ACTIVE: ${notActive.join(', ')}` : 'all ACTIVE'}; last updated ${newest}`)
  } catch (e) { add(`Functions: could not read (${e.message})`) }

  // Function errors since --since
  try {
    const body = { resourceNames: [`projects/${project}`], filter: `severity>=ERROR AND timestamp>="${since.toISOString()}"`, orderBy: 'timestamp desc', pageSize: 200 }
    const entries = (await call('https://logging.googleapis.com', 'v2', 'POST', '/entries:list', { body })).entries || []
    const by = new Map()
    for (const e of entries) {
      const k = e.resource?.labels?.service_name || e.resource?.labels?.function_name || e.resource?.type || '?'
      by.set(k, (by.get(k) || 0) + 1)
    }
    add(`Errors in logs since ${since.toISOString()}: ${entries.length}${entries.length ? ' — ' + [...by.entries()].map(([k, n]) => `${k} ${n}`).join(', ') : ''}${entries.length === 200 ? ' (200+, showing first page)' : ''}`)
    if (details) for (const e of entries.slice(0, 20)) add(`    ${e.timestamp} ${e.resource?.labels?.service_name || ''}: ${String(e.textPayload || e.jsonPayload?.message || '').split('\n')[0].slice(0, 160)}`)
  } catch (e) { add(`Errors in logs: could not read (${e.message})`) }

  // Firestore rule evaluations per 10 minutes since --since
  try {
    const query = {
      filter: 'metric.type = "firestore.googleapis.com/rules/evaluation_count"',
      'interval.startTime': since.toISOString(), 'interval.endTime': new Date().toISOString(),
      'aggregation.alignmentPeriod': '600s', 'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM', 'aggregation.groupByFields': 'metric.label.result',
    }
    const series = (await call('https://monitoring.googleapis.com', 'v3', 'GET', `/projects/${project}/timeSeries`, { query })).timeSeries || []
    const buckets = new Map()   // end time -> { ALLOW, DENY, ERROR }
    const seen = new Set()
    for (const ts of series) {
      const result = ts.metric?.labels?.result || '?'
      for (const p of ts.points || []) {
        const key = `${result}|${p.interval.endTime}`
        if (seen.has(key)) continue   // the API can repeat a series; count each point once
        seen.add(key)
        const b = buckets.get(p.interval.endTime) || { ALLOW: 0, DENY: 0, ERROR: 0 }
        b[result] = (b[result] || 0) + Number(p.value.int64Value || 0)
        buckets.set(p.interval.endTime, b)
      }
    }
    const rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    const tot = rows.reduce((t, [, b]) => ({ ALLOW: t.ALLOW + b.ALLOW, DENY: t.DENY + b.DENY, ERROR: t.ERROR + b.ERROR }), { ALLOW: 0, DENY: 0, ERROR: 0 })
    add(`Rule checks since ${since.toISOString()}: allowed ${tot.ALLOW}, refused ${tot.DENY}, errored ${tot.ERROR} (10-minute buckets, newest last; lags 3-5 min):`)
    for (const [end, b] of rows.slice(-12)) add(`    to ${end.slice(11, 16)}Z  allowed ${String(b.ALLOW).padStart(4)}  refused ${String(b.DENY).padStart(4)}${b.ERROR ? `  errored ${b.ERROR}` : ''}`)
    if (!rows.length) add('    (no rule checks recorded in this window)')
  } catch (e) { add(`Rule checks: could not read (${e.message})`) }

  console.log(lines.join('\n'))
}

await report()
while (watch > 0) {
  await new Promise(r => setTimeout(r, watch * 1000))
  await report()
}
