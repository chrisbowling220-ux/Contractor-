// Single source of truth for the public host used in all customer-facing
// share links (estimates, invoices, change orders, thank-you pages, photo logs).
//
// To switch the whole app to a different host, change ONLY this line — every
// share link across the app updates at once.
//
// LIVE on the custom domain builderspro.cc (SSL issued & verified 2026-06-01).
// The default .web.app URL still serves the same app as a fallback.
export const PUBLIC_HOST = 'https://builderspro.cc'

// Base URL for HTTP (onRequest) Cloud Functions — the public estimate/invoice
// pages POST here for deposit-invoice creation and Stripe checkout. Centralized
// so a project/region change is a one-line edit. (onCall functions use the
// Firebase SDK and don't need this.)
export const FUNCTIONS_BASE_URL = 'https://us-central1-contractors-office-96731.cloudfunctions.net'
