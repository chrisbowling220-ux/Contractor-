// Test harness for the Cloud Functions.
//
// The functions run for real against the local Firestore emulator. The paid
// outside services are replaced by stand-ins, so a test run can never charge a
// card, send an email or spend AI credit:
//   Clerk      verifyToken accepts "valid:<userId>" and rejects everything else
//   Anthropic  returns whatever the test queues in `ai.next`
//   Stripe     real library (so webhook signatures are verified for real, with
//              a made-up signing secret) but checkout/customers calls are stubs
//   Resend / ElevenLabs   global fetch is replaced; calls are recorded
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { vi } from 'vitest'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

export const WEBHOOK_SECRET = 'whsec_test_only_not_a_real_secret'

process.env.GCLOUD_PROJECT ||= 'demo-buildpro-fn'
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key'
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.CLERK_SECRET_KEY = 'sk_test_not_a_real_key'
process.env.ANTHROPIC_API_KEY = 'not-a-real-key'
process.env.RESEND_API_KEY = 'not-a-real-key'
process.env.ELEVENLABS_API_KEY = 'not-a-real-key'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Functions tests must run inside the Firestore emulator (npm run test:functions).')
}

export function db(): Firestore {
  if (getApps().length === 0) initializeApp()
  return getFirestore()
}

export async function clearDb() {
  const host = process.env.FIRESTORE_EMULATOR_HOST
  const res = await realFetch(`http://${host}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Could not clear the emulator: ' + res.status)
}

export async function seed(path: string, data: Record<string, unknown>) { await db().doc(path).set(data) }
export async function read(path: string) { return (await db().doc(path).get()).data() }
export async function all(name: string) {
  return (await db().collection(name).get()).docs.map(d => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
}

// ── Outside HTTP (Resend, ElevenLabs): recorded, never sent ──
export const realFetch = globalThis.fetch
export const outbound: Array<{ url: string; body: Record<string, unknown> }> = []
export const outboundReply = { status: 200, json: { id: 'email_test_1' } as Record<string, unknown> }
vi.stubGlobal('fetch', async (input: unknown, init?: { body?: unknown }) => {
  const url = String(input)
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
    return realFetch(input as never, init as never)
  }
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(String(init?.body ?? '{}')) } catch { /* not JSON */ }
  outbound.push({ url, body })
  return new Response(JSON.stringify(outboundReply.json), { status: outboundReply.status, headers: { 'Content-Type': 'application/json' } })
})

// ── Calling the functions ──
type Callable = { run: (request: unknown) => unknown }
// A signed-in contractor calling an onCall function.
export async function call<T = unknown>(fn: unknown, userId: string | null, input?: unknown): Promise<T> {
  const data = { ...(userId ? { clerkToken: `valid:${userId}` } : {}), ...(input !== undefined ? { input } : {}) }
  return await (fn as Callable).run({ data, rawRequest: {}, acceptsStreaming: false }) as T
}
export async function callRaw<T = unknown>(fn: unknown, data: unknown): Promise<T> {
  return await (fn as Callable).run({ data, rawRequest: {}, acceptsStreaming: false }) as T
}

// An onRequest function behind a real local HTTP server, with the raw body
// kept the way Cloud Functions provides it (Stripe signs the raw bytes).
export async function serve(fn: unknown): Promise<{ post: (body: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: Record<string, unknown>; text: string }>; get: () => Promise<number>; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf } }))
  app.all('/', fn as express.RequestHandler)
  const server: Server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return {
    async post(body, headers = {}) {
      const res = await realFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
      const text = await res.text()
      let json: Record<string, unknown> = {}
      try { json = JSON.parse(text) } catch { /* plain text reply */ }
      return { status: res.status, json, text }
    },
    async get() { return (await realFetch(url)).status },
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

// Expect an onCall function to fail with a given HttpsError code.
export async function failsWith(p: Promise<unknown>, code: string): Promise<string> {
  try {
    await p
  } catch (err) {
    const e = err as { code?: string; message?: string }
    if (e.code !== code) throw new Error(`expected "${code}" but got "${e.code}": ${e.message}`, { cause: err })
    return e.message || ''
  }
  throw new Error(`expected "${code}" but the call succeeded`)
}
