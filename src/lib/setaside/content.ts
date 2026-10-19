// Copy for the Safe-to-Spend page. Shared by the React page AND the build-time
// prerender in vite.config.ts, so the FAQ text, the FAQPage JSON-LD and the
// meta tags can never drift apart. Plain data only — no React.
import tax2026 from './taxYears/2026.ts'

export const PAGE_PATH = '/safe-to-spend'
export const PAGE_URL = 'https://builderspro.cc/safe-to-spend'

export const meta = {
  title: '1099 Tax Calculator for Contractors & Handymen | Safe-to-Spend | BuildPro+',
  description:
    'Just got paid? Free 1099 tax set-aside calculator for contractors, handymen and subs. See what to save for self-employment, federal and NC taxes, and what’s actually yours to spend.',
  h1: 'Safe-to-Spend Calculator',
  subhead: 'Just got paid? See what to set aside for taxes, and what’s actually yours.',
  image: 'https://builderspro.cc/icon-512.png',
}

export const TRADES = [
  'Handyman', 'General contractor', 'Carpenter', 'Electrician', 'Plumber', 'HVAC',
  'Painter', 'Roofer', 'Landscaping/lawn', 'Flooring', 'Other',
] as const

const cents = (c: number) => `${c}¢`
const [mileH1, mileH2] = tax2026.mileage

export const writeOffs: { title: string; body: string }[] = [
  {
    title: 'Truck mileage',
    body: `Business miles in 2026 are worth ${cents(mileH1.centsPerMile)} a mile through June 30 and ${cents(mileH2.centsPerMile)} a mile from July 1 (IRS standard mileage rate). Driving between jobs, to the supply house, and to bid counts; your commute from home to a regular shop usually doesn’t. Keep a log with date, miles and purpose. Parking and tolls on business trips are deductible on top.`,
  },
  { title: 'Tools and equipment', body: 'Saws, drills, ladders, compressors, trailers and other gear you buy for the work. Most can be written off in the year you buy them.' },
  { title: 'Materials and supplies', body: 'Lumber, fasteners, wire, pipe, paint, caulk and anything else that goes into a job, plus shop supplies and consumables like blades and bits.' },
  { title: 'Safety gear', body: 'Hard hats, safety glasses, hearing protection, gloves, respirators, harnesses and steel- or composite-toe boots.' },
  { title: 'Phone and internet (business part)', body: 'The share of your cell phone and internet bill that’s used for the business. If it’s 60% business use, deduct 60%.' },
  { title: 'Licenses and insurance', body: 'Contractor license and renewal fees, business registration, bonding, and general liability or tool insurance for the business.' },
  { title: 'Software', body: 'Estimating, invoicing, scheduling and bookkeeping apps you pay for to run the business.' },
  { title: 'Workwear — only if it isn’t everyday clothing', body: 'Clothing counts only when it’s required for the work and not suitable for everyday wear, like flame-resistant (FR) gear or uniforms with your company logo. Regular jeans, T-shirts and work boots you could wear anywhere usually don’t qualify.' },
]

const due = tax2026.estimatedDueDates.map(d => {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
})

export const faq: { q: string; a: string }[] = [
  {
    q: 'How much should a 1099 contractor set aside?',
    a: 'Most solo contractors should set aside somewhere between 20% and 30% of their profit (what’s left after materials and expenses), not of every dollar that comes in. Self-employment tax alone is about 14.1% of profit, and federal and state income tax come on top. A single filer in North Carolina clearing $50,000 a year should save about 23%. Use the calculator above for your own number.',
  },
  {
    q: 'What is self-employment tax?',
    a: `It’s Social Security and Medicare for people who work for themselves. You pay both the employee and employer halves: 12.4% for Social Security (on up to $${tax2026.ssWageBase.toLocaleString('en-US')} of earnings in 2026) plus 2.9% for Medicare, figured on 92.35% of your net profit. You owe it once your net self-employment earnings reach $400, and you get to deduct half of it on your income tax return.`,
  },
  {
    q: 'When are quarterly taxes due?',
    a: `For the 2026 tax year, estimated payments are due ${due[0]}, ${due[1]}, ${due[2]}, and ${due[3]}. If a date falls on a weekend or legal holiday, it moves to the next business day. You can pay the IRS online through IRS Direct Pay or your IRS Online Account.`,
  },
  {
    q: 'Do I have to pay quarterly?',
    a: 'Generally yes, if you expect to owe $1,000 or more in federal tax for the year after subtracting withholding and credits. If you also have a W-2 job, you can raise your withholding there instead of (or as well as) sending quarterly payments. Skipping payments you owe can mean an underpayment penalty, even if you pay everything in April.',
  },
  {
    q: 'What’s the safe harbor rule?',
    a: 'You generally won’t owe an underpayment penalty if your withholding plus on-time estimated payments cover at least 90% of this year’s tax, or 100% of last year’s tax (110% if last year’s adjusted gross income was over $150,000, or $75,000 if married filing separately). Paying 100% or 110% of last year’s tax in four equal payments is the simplest way to stay penalty-free when your income jumps around.',
  },
]

export const disclaimer =
  'Estimate only, for planning. Not tax advice. Your actual tax depends on your full return, so check with a tax pro.'

/** JSON-LD blocks for the page head (WebApplication + FAQPage). */
export function jsonLd(): object[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'Safe-to-Spend Calculator',
      url: PAGE_URL,
      description: meta.description,
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Any',
      browserRequirements: 'Requires JavaScript',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@type': 'Organization', name: 'BuildPro+', url: 'https://builderspro.cc/' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ]
}
