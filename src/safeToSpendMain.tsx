// Entry for the standalone /safe-to-spend page (safe-to-spend.html). It loads
// only the calculator — no Clerk and none of the signed-in app — so it's fast
// on a phone at a jobsite. The same page is also routed inside App.tsx.
import React from 'react'
import ReactDOM from 'react-dom/client'
import SafeToSpend from './SafeToSpend'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SafeToSpend />
  </React.StrictMode>,
)
