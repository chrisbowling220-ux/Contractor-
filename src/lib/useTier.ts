import { useEffect, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'

const FREE_TIER_AI_LIMIT = 10

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
        subscriptionCurrentPeriodEnd?: number; cancelAtPeriodEnd?: boolean; subscriptionStatus?: string
      } | undefined
      setTier(data?.tier === 'pro' ? 'pro' : 'free')
      setAiQuotesUsed(data?.aiQuotesUsed || 0)
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
