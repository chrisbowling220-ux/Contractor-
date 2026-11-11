import React from 'react'
import ReactDOM from 'react-dom/client'
import Root from './Root'
import ErrorBoundary from './lib/ErrorBoundary'
import OfflineNotice from './lib/OfflineNotice'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <OfflineNotice />
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
)
