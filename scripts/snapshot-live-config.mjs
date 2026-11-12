// Read-only snapshot of what is deployed right now: the live Firestore and
// Storage rules (full source), the live Hosting version, and the deployed
// Cloud Functions. Saved under ~/buildpro-backups/live-<project>-<time>/ so a
// rollback has an exact target, and compared with the git tags the runbook
// restores from. Reads configuration only, never data. Writes nothing to the
// project.
//
//   node scripts/snapshot-live-config.mjs --project contractors-office-96731
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const project = value('--project')
const outRoot = value('--out') || join(homedir(), 'buildpro-backups')
if (!project) { console.error('Usage: --project <id> [--out <dir>]'); process.exit(2) }

const require = createRequire(import.meta.url)
const root = join(execFileSync('npm', ['root', '-g']).toString().trim(), 'firebase-tools/lib')
const { requireAuth } = require(`${root}/requireAuth.js`)
const { Client } = require(`${root}/apiv2.js`)
const api = require(`${root}/api.js`)
const acct = require(`${root}/auth.js`).getGlobalDefaultAccount()
if (!acct) throw new Error('The Firebase CLI is not signed in (run: npx firebase login)')
await requireAuth({ project, projectId: project, user: acct.user, tokens: acct.tokens })
const get = async (origin, version, path) =>
  (await new Client({ urlPrefix: origin, apiVersion: version }).request({ method: 'GET', path, skipLog: { resBody: true } })).body

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dir = join(outRoot, `live-${project}-${stamp}`)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const save = (name, content) => writeFileSync(join(dir, name), content, { mode: 0o600 })
const gitShow = (ref, path) => { try { return execFileSync('git', ['show', `${ref}:${path}`]).toString() } catch { return null } }
const norm = (s) => (s || '').replace(/\r\n/g, '\n').trim()

const summary = { project, takenAt: new Date().toISOString() }

// ── Rules ────────────────────────────────────────────────────────────────────
const releases = (await get(api.rulesOrigin(), 'v1', `/projects/${project}/releases`)).releases || []
for (const rel of releases) {
  const kind = rel.name.includes('cloud.firestore') ? 'firestore' : rel.name.includes('firebase.storage') ? 'storage' : null
  if (!kind) continue
  const rulesetId = rel.rulesetName.split('/').pop()
  const rs = await get(api.rulesOrigin(), 'v1', `/projects/${project}/rulesets/${rulesetId}`)
  const source = rs.source?.files?.map(f => f.content).join('\n') || ''
  save(`${kind}.rules`, source)
  summary[`${kind}Rules`] = { release: rel.name, ruleset: rulesetId, updated: rel.updateTime }
}

// ── Hosting ──────────────────────────────────────────────────────────────────
const live = await get(api.hostingApiOrigin(), 'v1beta1', `/projects/-/sites/${project}/channels/live`)
summary.hosting = { version: live.release?.version?.name?.split('/').pop(), released: live.release?.releaseTime }

// ── Functions ────────────────────────────────────────────────────────────────
const fns = (await get(api.functionsV2Origin(), 'v2', `/projects/${project}/locations/-/functions?pageSize=200`)).functions || []
summary.functions = fns.map(f => ({ name: f.name.split('/').pop(), runtime: f.buildConfig?.runtime, state: f.state, updated: f.updateTime }))
  .sort((a, b) => a.name.localeCompare(b.name))

save('summary.json', JSON.stringify(summary, null, 1))

// ── Compare with the rollback tags the runbook uses ─────────────────────────
const checks = [
  ['Firestore rules', 'firestore.rules', 'rules/stage1-urgent', 'firestore.rules'],
  ['Storage rules', 'storage.rules', 'checkpoint/pre-audit-2026-11-10', 'storage.rules'],
]
console.log(`Live configuration of ${project}, saved to ${dir}`)
for (const [label, file, tag, path] of checks) {
  const liveSrc = (() => { try { return require('node:fs').readFileSync(join(dir, file), 'utf8') } catch { return null } })()
  const tagSrc = gitShow(tag, path)
  const match = liveSrc !== null && tagSrc !== null && norm(liveSrc) === norm(tagSrc)
  console.log(`${label}: ruleset ${summary[file.replace('.rules', 'Rules')]?.ruleset ?? '?'} — ${match ? `identical to ${tag}` : `DIFFERS from ${tag}`}`)
}
console.log(`Hosting: live version ${summary.hosting.version} (released ${summary.hosting.released})`)
const runtimes = [...new Set(summary.functions.map(f => f.runtime))].join(', ')
const states = [...new Set(summary.functions.map(f => f.state))].join(', ')
console.log(`Functions: ${summary.functions.length} deployed (runtime ${runtimes}; state ${states})`)
const src = execFileSync('git', ['show', 'HEAD:functions/src/index.ts']).toString()
const exported = new Set([...src.matchAll(/^export const (\w+)/gm)].map(m => m[1]))
const deployed = new Set(summary.functions.map(f => f.name))
const missing = [...exported].filter(n => !deployed.has(n))
const extra = [...deployed].filter(n => !exported.has(n))
console.log(`  release exports ${exported.size}; not yet deployed: ${missing.length ? missing.join(', ') : 'none'}; deployed but not in release: ${extra.length ? extra.join(', ') : 'none'}`)
