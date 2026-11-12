// Firestore over its REST API, for the one-time maintenance scripts in
// scripts/. Talks to the emulator when FIRESTORE_EMULATOR_HOST is set, and to
// the real project otherwise, signed in with the Firebase CLI's own login (so
// no service-account key is needed or created). Requests log no bodies.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export function connect(project) {
  const emulator = process.env.FIRESTORE_EMULATOR_HOST
  const docsPath = `projects/${project}/databases/(default)/documents`
  let request
  if (emulator) {
    request = async (method, path, body, query = {}) => {
      const qs = new URLSearchParams(query).toString()
      const res = await fetch(`http://${emulator}/v1/${path}${qs ? '?' + qs : ''}`, {
        method, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        const err = new Error(`${method}: HTTP ${res.status}`)
        err.status = res.status
        throw err
      }
      return res.json()
    }
  } else {
    const require = createRequire(import.meta.url)
    const root = join(execFileSync('npm', ['root', '-g']).toString().trim(), 'firebase-tools/lib')
    const { requireAuth } = require(`${root}/requireAuth.js`)
    const { Client } = require(`${root}/apiv2.js`)
    const { firestoreOrigin } = require(`${root}/api.js`)
    const acct = require(`${root}/auth.js`).getGlobalDefaultAccount()
    if (!acct) throw new Error('The Firebase CLI is not signed in (run: npx firebase login)')
    let ready
    request = async (method, path, body, query = {}) => {
      ready ??= requireAuth({ project, projectId: project, user: acct.user, tokens: acct.tokens })
      await ready
      const client = new Client({ urlPrefix: firestoreOrigin(), apiVersion: 'v1' })
      try {
        return (await client.request({ method, path: `/${path}`, body, queryParams: query, skipLog: { body: true, resBody: true } })).body
      } catch (e) {
        // Never echo the request (it can carry document contents).
        const err = new Error(`${method}: ${e?.context?.response?.statusCode ?? e?.status ?? 'request failed'}`)
        err.status = e?.context?.response?.statusCode ?? e?.status
        throw err
      }
    }
  }
  return { request, docsPath, emulator }
}

export const fromValue = (v) => {
  if ('stringValue' in v) return v.stringValue
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('timestampValue' in v) return v.timestampValue
  if ('nullValue' in v) return null
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue)
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {})
  return undefined   // references, bytes, geo points: never used by these scripts
}
export const fromFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromValue(v)]))
export const toValue = (v) => {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } }
  return { mapValue: { fields: toFields(v) } }
}
export const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)]))

// Every document in a collection, with its raw REST fields and updateTime
// kept alongside the plain values (the raw form restores losslessly).
export async function listRaw({ request, docsPath }, collection) {
  const out = []
  let pageToken
  do {
    const page = await request('GET', `${docsPath}/${collection}`, undefined, { pageSize: '300', ...(pageToken ? { pageToken } : {}) })
    for (const d of page.documents || []) {
      out.push({ id: d.name.split('/').pop(), name: d.name, updateTime: d.updateTime, fields: d.fields || {}, data: fromFields(d.fields) })
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

// Plain values only: { id, ...fields }.
export async function listAll(conn, collection) {
  return (await listRaw(conn, collection)).map(d => ({ id: d.id, ...d.data }))
}
