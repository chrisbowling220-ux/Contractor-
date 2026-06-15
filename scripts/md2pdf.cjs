#!/usr/bin/env node
/* Minimal Markdown -> styled HTML converter for producing printable PDFs of the
 * BuildPro+ pitch docs. No external deps. Handles: h1-h4, bold, italic, inline
 * code, links, bullet/numbered lists, tables, blockquotes, horizontal rules,
 * and paragraphs. Then we render the HTML to PDF with LibreOffice (headless).
 *
 * Usage: node scripts/md2pdf.cjs <input.md> <output.html>
 */
const fs = require('fs')

const [, , inPath, outPath] = process.argv
if (!inPath || !outPath) { console.error('usage: md2pdf.cjs in.md out.html'); process.exit(1) }

const src = fs.readFileSync(inPath, 'utf8')
const lines = src.split('\n')

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
// Inline formatting: code, bold, italic, links. Order matters.
function inline(s) {
  s = esc(s)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return s
}

const out = []
let i = 0
let inList = null // 'ul' | 'ol'

function closeList() { if (inList) { out.push(`</${inList}>`); inList = null } }

while (i < lines.length) {
  let line = lines[i]

  // Horizontal rule
  if (/^---+\s*$/.test(line)) { closeList(); out.push('<hr/>'); i++; continue }

  // Headings
  const h = line.match(/^(#{1,6})\s+(.*)$/)
  if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); i++; continue }

  // Table: a line with | and a following |---| separator
  if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
    closeList()
    const header = line.split('|').map(c => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === ''))
    i += 2 // skip header + separator
    const rows = []
    while (i < lines.length && lines[i].includes('|')) {
      const cells = lines[i].split('|').map(c => c.trim())
      // drop leading/trailing empties from surrounding pipes
      if (cells[0] === '') cells.shift()
      if (cells[cells.length - 1] === '') cells.pop()
      rows.push(cells)
      i++
    }
    out.push('<table>')
    out.push('<thead><tr>' + header.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead>')
    out.push('<tbody>' + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody>')
    out.push('</table>')
    continue
  }

  // Blockquote
  if (/^>\s?/.test(line)) {
    closeList()
    const buf = []
    while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
    out.push(`<blockquote>${buf.map(b => inline(b)).join('<br/>')}</blockquote>`)
    continue
  }

  // Unordered list
  let m = line.match(/^\s*[-*]\s+(.*)$/)
  if (m) {
    if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul' }
    out.push(`<li>${inline(m[1])}</li>`); i++; continue
  }
  // Ordered list
  m = line.match(/^\s*\d+\.\s+(.*)$/)
  if (m) {
    if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol' }
    out.push(`<li>${inline(m[1])}</li>`); i++; continue
  }

  // Blank line
  if (/^\s*$/.test(line)) { closeList(); i++; continue }

  // Paragraph (gather consecutive non-empty, non-special lines)
  closeList()
  const para = [line]
  i++
  while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|>\s?|---+\s*$|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]) && !lines[i].includes('|')) {
    para.push(lines[i]); i++
  }
  out.push(`<p>${inline(para.join(' '))}</p>`)
}
closeList()

const title = (src.match(/^#\s+(.*)$/m) || [, 'BuildPro+'])[1].replace(/[*_`]/g, '')

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: Letter; margin: 0.8in; }
  * { box-sizing: border-box; }
  body { font-family: 'Liberation Sans', Arial, sans-serif; color: #1a1f2e; line-height: 1.5; font-size: 11.5pt; }
  h1 { color: #1a1f2e; font-size: 26pt; margin: 0 0 4pt; border-bottom: 3px solid #f97316; padding-bottom: 6pt; }
  h2 { color: #f97316; font-size: 16pt; margin: 18pt 0 6pt; }
  h3 { color: #1a1f2e; font-size: 13pt; margin: 14pt 0 4pt; }
  h4 { color: #334155; font-size: 11.5pt; margin: 10pt 0 4pt; }
  p { margin: 6pt 0; }
  ul, ol { margin: 6pt 0; padding-left: 22pt; }
  li { margin: 3pt 0; }
  strong { color: #1a1f2e; }
  code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-family: 'Liberation Mono', monospace; font-size: 10pt; }
  a { color: #2563eb; text-decoration: none; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 14pt 0; }
  blockquote { border-left: 4px solid #f97316; background: #fff7ed; margin: 10pt 0; padding: 8pt 12pt; color: #7c2d12; font-style: italic; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 10.5pt; }
  th { background: #1a1f2e; color: #fff; text-align: left; padding: 6pt 8pt; }
  td { border: 1px solid #e2e8f0; padding: 6pt 8pt; vertical-align: top; }
  tr:nth-child(even) td { background: #f8fafc; }
</style></head>
<body>
${out.join('\n')}
</body></html>`

fs.writeFileSync(outPath, html)
console.log('wrote', outPath)
