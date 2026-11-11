import React from 'react'
import ReactDOM from 'react-dom/client'
import Root from './Root'
import ErrorBoundary from './lib/ErrorBoundary'
import OfflineNotice from './lib/OfflineNotice'
import './index.css'

// Offline launch page only (see public/sw.js): the worker caches nothing but
// /offline.html. Production builds only, so local development is unaffected.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('Offline page unavailable:', err))
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <OfflineNotice />
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
)
