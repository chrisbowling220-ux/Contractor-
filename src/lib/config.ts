// Single source of truth for the public host used in all customer-facing
// share links (estimates, invoices, change orders, thank-you pages, photo logs).
//
// To switch the whole app to the custom domain, change ONLY this line — every
// share link across the app updates at once. Keep it on the .web.app URL until
// the custom domain shows "Connected" with SSL issued in Firebase Hosting, so
// links never break for customers.
//
// Custom domain (once SSL is live): 'https://builderspro.cc'
export const PUBLIC_HOST = 'https://contractors-office-96731.web.app'
