import { Suspense, lazy } from 'react'

// Decides what to load from the URL, and loads only that.
//
// A customer opening an estimate or invoice link on their phone used to
// download the entire contractor app and the sign-in SDK just to read one page.
// Each customer-facing page is now its own small bundle, and the contractor app
// (with sign-in) is loaded only when someone is actually using the app.

const PublicEstimate = lazy(() => import('./PublicEstimate'))
const PublicPhotoLog = lazy(() => import('./PublicPhotoLog'))
const PublicChangeOrder = lazy(() => import('./PublicChangeOrder'))
const PublicThankYou = lazy(() => import('./PublicThankYou'))
const PublicInvoice = lazy(() => import('./PublicInvoice'))
const TermsPage = lazy(() => import('./LegalPages').then(m => ({ default: m.TermsPage })))
const PrivacyPage = lazy(() => import('./LegalPages').then(m => ({ default: m.PrivacyPage })))
const SafeToSpend = lazy(() => import('./SafeToSpend'))
const ContractorApp = lazy(() => import('./ContractorApp'))

export type Route =
  | { page: 'estimate' | 'photo-log' | 'change-order' | 'thank-you' | 'invoice'; id: string }
  | { page: 'terms' | 'privacy' | 'safe-to-spend' | 'app' }

const ID_ROUTES: [prefix: string, page: Extract<Route, { id: string }>['page']][] = [
  ['q', 'estimate'],         // /q/<id>      shared estimate
  ['log', 'photo-log'],      // /log/<id>    customer photo log
  ['co', 'change-order'],    // /co/<id>     change order
  ['thanks', 'thank-you'],   // /thanks/<id> thank-you package
  ['inv', 'invoice'],        // /inv/<id>    invoice / receipt
]

// eslint-disable-next-line react-refresh/only-export-components -- pure URL matcher, kept beside the routes it serves
export function routeFor(pathname: string): Route {
  for (const [prefix, page] of ID_ROUTES) {
    const m = pathname.match(new RegExp(`^/${prefix}/([A-Za-z0-9_-]+)/?$`))
    if (m) return { page, id: m[1] }
  }
  const p = pathname.replace(/\/$/, '')
  if (p === '/terms') return { page: 'terms' }
  if (p === '/privacy') return { page: 'privacy' }
  if (p === '/safe-to-spend') return { page: 'safe-to-spend' }
  return { page: 'app' }
}

function Loading() {
  return (
    <div role="status" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', color: '#475569', fontSize: '14px' }}>
      Loading…
    </div>
  )
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'estimate': return <PublicEstimate estimateId={route.id} />
    case 'photo-log': return <PublicPhotoLog customerId={route.id} />
    case 'change-order': return <PublicChangeOrder changeOrderId={route.id} />
    case 'thank-you': return <PublicThankYou packageId={route.id} />
    case 'invoice': return <PublicInvoice invoiceId={route.id} />
    case 'terms': return <TermsPage />
    case 'privacy': return <PrivacyPage />
    case 'safe-to-spend': return <SafeToSpend />
    default: return <ContractorApp />
  }
}

export default function Root() {
  return (
    <Suspense fallback={<Loading />}>
      <Page route={routeFor(window.location.pathname)} />
    </Suspense>
  )
}
