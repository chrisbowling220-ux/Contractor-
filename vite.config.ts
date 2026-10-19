import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { PAGE_URL, disclaimer, faq, jsonLd, meta, writeOffs } from './src/lib/setaside/content.ts'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The app is a client-rendered SPA, so crawlers and link previews would only
// see index.html's generic tags. /safe-to-spend is its own page instead
// (safe-to-spend.html → dist/safe-to-spend.html, rewritten in firebase.json):
// this fills in its head tags and JSON-LD, plus a static copy of its text in
// #root that React replaces on load. All of it comes from content.ts.
function prerenderSafeToSpend(): Plugin {
  return {
    name: 'prerender-safe-to-spend',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('safe-to-spend.html')) return html
        const ld = jsonLd()
          .map(o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`)
        const head = [
          `<title>${esc(meta.title)}</title>`,
          `<meta name="description" content="${esc(meta.description)}" />`,
          `<link rel="canonical" href="${PAGE_URL}" />`,
          `<meta property="og:type" content="website" />`,
          `<meta property="og:site_name" content="BuildPro+" />`,
          `<meta property="og:url" content="${PAGE_URL}" />`,
          `<meta property="og:title" content="${esc(meta.title)}" />`,
          `<meta property="og:description" content="${esc(meta.description)}" />`,
          `<meta property="og:image" content="${meta.image}" />`,
          `<meta name="twitter:card" content="summary" />`,
          `<meta name="twitter:title" content="${esc(meta.title)}" />`,
          `<meta name="twitter:description" content="${esc(meta.description)}" />`,
          `<meta name="twitter:image" content="${meta.image}" />`,
          ...ld,
        ].join('\n    ')
        const body = [
          `<main style="max-width:640px;margin:0 auto;padding:20px 16px">`,
          `<h1>${esc(meta.h1)}</h1>`,
          `<p>${esc(meta.subhead)}</p>`,
          `<p>${esc(disclaimer)}</p>`,
          `<h2>Common write-offs for the trades</h2>`,
          ...writeOffs.map(w => `<h3>${esc(w.title)}</h3><p>${esc(w.body)}</p>`),
          `<h2>Frequently asked questions</h2>`,
          ...faq.map(f => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`),
          `</main>`,
        ].join('')
        if (!html.includes('<!--safe-to-spend:head-->') || !html.includes('<!--safe-to-spend:body-->')) {
          throw new Error('prerender-safe-to-spend: placeholders missing from safe-to-spend.html')
        }
        return html.replace('<!--safe-to-spend:head-->', head).replace('<!--safe-to-spend:body-->', body)
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), prerenderSafeToSpend()],
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        safeToSpend: resolve(import.meta.dirname, 'safe-to-spend.html'),
      },
    },
  },
})
