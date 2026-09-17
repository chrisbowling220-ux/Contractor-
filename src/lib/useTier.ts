import { useEffect, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'

export const FREE_TIER_AI_LIMIT = 10

// Fields the free-allowance rule depends on.
export interface QuotaFields {
  aiQuotesUsed?: number
  proQuotesUsed?: number
  stripeSubscriptionId?: string
  freeAllowanceRepairedAt?: string
}

// How many FREE quotes a user has really spent.
//
// Pro usage used to be charged to `aiQuotesUsed`, so any account that ever held
// a subscription has a counter inflated by quotes they actually paid for. The
// backend re-files that on their next quote (the one-time repair in
// consumeAiQuoteOrThrow); until it does, the stored number would tell them
// "0 quotes left" when the next tap will in fact work. Treat the allowance as
// untouched while that repair is still pending, so the UI matches the server.
export function effectiveAiQuotesUsed(data: QuotaFields | undefined): number {
  const pendingRepair = !data?.freeAllowanceRepairedAt
    && data?.proQuotesUsed === undefined
    && !!data?.stripeSubscriptionId
  return pendingRepair ? 0 : (data?.aiQuotesUsed || 0)
}

// Live read of the signed-in contractor's subscription tier + quote usage +
// pay-as-you-go credits. Mirrors what Settings shows, so any screen can Pro-gate
// a feature or show the "quotes left" countdown. (The server still enforces
// gating — this is just for nice UX.)
//
// quotesLeft = remaining free quotes + any paid $1 credits. `null` = unlimited (Pro).
export function useTier(): {
  tier: 'free' | 'pro'
  aiQuotesUsed: number
  paidQuoteCredits: number
  quotesLeft: number | null
  currentPeriodEnd: number | null   // epoch ms — Pro access is good through this date
  cancelAtPeriodEnd: boolean        // true = set to cancel, access ends at currentPeriodEnd
  subscriptionStatus: string | null
  loading: boolean
} {
  const { user } = useUser()
  const [tier, setTier] = useState<'free' | 'pro'>('free')
  const [aiQuotesUsed, setAiQuotesUsed] = useState(0)
  const [paidQuoteCredits, setPaidQuoteCredits] = useState(0)
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<number | null>(null)
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false)
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.id) { setLoading(false); return }
    const unsub = onSnapshot(doc(db, 'users', user.id), snap => {
      const data = snap.data() as {
        tier?: 'free' | 'pro'; aiQuotesUsed?: number; paidQuoteCredits?: number
        proQuotesUsed?: number; stripeSubscriptionId?: string; freeAllowanceRepairedAt?: string
        subscriptionCurrentPeriodEnd?: number; cancelAtPeriodEnd?: boolean; subscriptionStatus?: string
      } | undefined
      setTier(data?.tier === 'pro' ? 'pro' : 'free')
      setAiQuotesUsed(effectiveAiQuotesUsed(data))
      setPaidQuoteCredits(Math.max(0, data?.paidQuoteCredits || 0))
      setCurrentPeriodEnd(typeof data?.subscriptionCurrentPeriodEnd === 'number' ? data.subscriptionCurrentPeriodEnd : null)
      setCancelAtPeriodEnd(!!data?.cancelAtPeriodEnd)
      setSubscriptionStatus(data?.subscriptionStatus ?? null)
      setLoading(false)
    }, err => { console.error('useTier listener failed:', err); setLoading(false) })
    return () => unsub()
  }, [user?.id])

  const quotesLeft = tier === 'pro'
    ? null
    : Math.max(0, FREE_TIER_AI_LIMIT - aiQuotesUsed) + paidQuoteCredits

  return { tier, aiQuotesUsed, paidQuoteCredits, quotesLeft, currentPeriodEnd, cancelAtPeriodEnd, subscriptionStatus, loading }
}
