// Stand-ins for the paid services. Loaded as a vitest setup file, so the
// replacements are registered before any test imports the functions.
import { vi } from 'vitest'

interface AiState {
  // What the next model call returns: a finished message, or an Error to throw.
  next: unknown
  calls: Array<Record<string, unknown>>
}
interface StripeState {
  checkoutCalls: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }>
  checkoutError: Error | null
}
// Shared through globalThis so the mock factories (hoisted above everything in
// this file) and the tests see the same objects.
const g = globalThis as unknown as { __aiStub?: AiState; __stripeStub?: StripeState }
g.__aiStub ??= { next: null, calls: [] }
g.__stripeStub ??= { checkoutCalls: [], checkoutError: null }
export const ai = g.__aiStub
export const stripeStub = g.__stripeStub

export function aiMessage(json: unknown, extra: Record<string, unknown> = {}) {
  return { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(json) }], ...extra }
}

vi.mock('@clerk/backend', () => ({
  verifyToken: async (token: string) => {
    if (typeof token === 'string' && token.startsWith('valid:')) return { sub: token.slice('valid:'.length) }
    throw new Error('invalid token')
  },
}))

vi.mock('@anthropic-ai/sdk', () => {
  const state = (globalThis as unknown as { __aiStub: AiState }).__aiStub
  const respond = async (params: Record<string, unknown>) => {
    state.calls.push(params)
    if (state.next instanceof Error) throw state.next
    if (state.next == null) throw new Error('test did not queue a model reply')
    return state.next
  }
  class FakeAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => ({ finalMessage: () => respond(params) }),
      create: (params: Record<string, unknown>) => respond(params),
    }
  }
  return { default: FakeAnthropic }
})

vi.mock('stripe', async importOriginal => {
  const state = (globalThis as unknown as { __stripeStub: StripeState }).__stripeStub
  const mod = await importOriginal<{ default: new (...a: unknown[]) => Record<string, unknown> }>()
  const Real = mod.default
  // The real library, so webhooks.constructEvent verifies signatures for real.
  // Anything that would talk to Stripe is replaced.
  class FakeStripe extends Real {
    constructor(...args: unknown[]) {
      super(...args)
      this.checkout = {
        sessions: {
          create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
            if (state.checkoutError) throw state.checkoutError
            state.checkoutCalls.push({ params, options })
            return { id: 'cs_test_123', url: 'https://checkout.stripe.test/cs_test_123' }
          },
        },
      }
    }
  }
  return { ...mod, default: FakeStripe }
})
