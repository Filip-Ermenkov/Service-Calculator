/**
 * Branded quote HTML template (Phase 4 — FUNCTIONALITY §4, TECHSPEC §6.5).
 *
 * A pure `QuoteModel -> HTML string` renderer. Deliberately self-contained: all
 * CSS is inlined and only fonts guaranteed to exist in the serverless Chromium
 * image (Open Sans, shipped by @sparticuz/chromium) plus generic fallbacks are
 * used — no external stylesheet, web-font or image fetch, so PDF rendering has
 * no network dependency and can't fail on a slow/blocked asset. The company
 * wordmark is rendered as styled text (the site itself uses a text logo), not a
 * fetched image, for the same robustness reason.
 *
 * The HTML mirrors the site's design tokens (brand orange #BF4C00, near-black
 * ink, the same grey ramp) so a downloaded quote is visibly the same brand as
 * the page it came from. All interpolated content is HTML-escaped.
 */

import type { QuoteModel } from './quote'

/** Escape the five HTML-significant characters in interpolated text. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Render the complete, self-contained quote document as an HTML string. */
export function renderQuoteHtml(model: QuoteModel): string {
  const { company, text } = model
  const e = escapeHtml

  const contactBits: string[] = []
  if (company.phone) {
    contactBits.push(`<span>${e(text.phoneLabel)}: ${e(company.phone)}</span>`)
  }
  if (company.email) {
    contactBits.push(`<span>${e(text.emailLabel)}: ${e(company.email)}</span>`)
  }
  const contactLine = contactBits.join('<span class="sep">·</span>')

  const showPriceCol = model.showContributions
  const paramRows = model.lines
    .map((line) => {
      const priceCell = showPriceCol
        ? `<td class="num">${line.contributionDisplay ? e(line.contributionDisplay) : ''}</td>`
        : ''
      return `<tr>
        <td class="param">${e(line.label)}</td>
        <td class="val">${e(line.valueDisplay)}</td>
        ${priceCell}
      </tr>`
    })
    .join('')

  const priceHeader = showPriceCol ? `<th class="num">${e(text.priceColumn)}</th>` : ''

  const totalBlock = model.hasTotal
    ? `<div class="total-amount">${e(model.totalDisplay ?? '')}</div>`
    : `<div class="total-contact">${e(text.contactForPrice)}</div>`

  const paramsTable = model.lines.length
    ? `<table class="params">
        <thead>
          <tr>
            <th class="param">${e(text.paramColumn)}</th>
            <th class="val">${e(text.valueColumn)}</th>
            ${priceHeader}
          </tr>
        </thead>
        <tbody>${paramRows}</tbody>
      </table>`
    : ''

  return `<!DOCTYPE html>
<html lang="${e(model.locale)}">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    font-family: "Open Sans", "Helvetica Neue", Arial, sans-serif;
    color: #1F1F1F;
    font-size: 12px;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page { padding: 40px 44px; }
  .header {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 3px solid #BF4C00; padding-bottom: 16px; margin-bottom: 24px;
  }
  .wordmark {
    font-size: 26px; font-weight: 800; letter-spacing: -0.5px; color: #1F1F1F;
  }
  .wordmark .dot { color: #BF4C00; }
  .contact { text-align: right; font-size: 10.5px; color: #525252; }
  .contact span { display: block; }
  .disclaimer {
    background: #FFF3EC; border-left: 4px solid #BF4C00;
    padding: 12px 16px; margin-bottom: 24px; border-radius: 4px;
  }
  .disclaimer .d-title {
    font-weight: 700; color: #BF4C00; text-transform: uppercase;
    letter-spacing: 0.04em; font-size: 10.5px; margin-bottom: 3px;
  }
  .disclaimer .d-body { color: #404040; font-size: 11px; }
  h1.doc-title {
    font-size: 22px; font-weight: 800; letter-spacing: -0.3px; margin-bottom: 12px;
  }
  .meta { margin-bottom: 22px; }
  .meta .row { display: flex; gap: 8px; font-size: 12px; margin-bottom: 2px; }
  .meta .row .label {
    color: #737373; min-width: 96px; text-transform: uppercase;
    letter-spacing: 0.04em; font-size: 10px; padding-top: 1px;
  }
  .meta .row .value { color: #1F1F1F; font-weight: 600; }
  table.params { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  table.params th {
    text-align: left; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.05em; color: #737373; font-weight: 700;
    padding: 8px 10px; border-bottom: 2px solid #E5E5E5;
  }
  table.params td {
    padding: 9px 10px; border-bottom: 1px solid #F0F0F0;
    font-size: 12px; color: #404040;
  }
  table.params td.param { color: #1F1F1F; font-weight: 600; }
  table.params .num { text-align: right; white-space: nowrap; }
  .total {
    display: flex; justify-content: space-between; align-items: center;
    background: #1F1F1F; color: #fff; padding: 18px 22px; border-radius: 6px;
  }
  .total .total-label {
    text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px;
    font-weight: 700; color: #D4D4D4;
  }
  .total .total-amount { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
  .total .total-contact { font-size: 17px; font-weight: 700; color: #FF6D1F; }
  .footer {
    margin-top: 32px; padding-top: 16px; border-top: 1px solid #E5E5E5;
    color: #737373; font-size: 10.5px;
  }
  .footer .note { margin-bottom: 6px; color: #525252; }
  .footer .fcontact span { margin-right: 4px; }
  .footer .sep, .contact .sep { margin: 0 6px; color: #BFBFBF; }
</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="wordmark">${e(company.name)}<span class="dot">.</span></div>
      <div class="contact">${contactLine}</div>
    </div>

    <div class="disclaimer">
      <div class="d-title">${e(text.disclaimerTitle)}</div>
      <div class="d-body">${e(text.disclaimerBody)}</div>
    </div>

    <h1 class="doc-title">${e(text.title)}</h1>

    <div class="meta">
      <div class="row"><span class="label">${e(text.serviceLabel)}</span><span class="value">${e(model.serviceTitle)}</span></div>
      <div class="row"><span class="label">${e(text.dateLabel)}</span><span class="value">${e(model.dateDisplay)}</span></div>
    </div>

    ${paramsTable}

    <div class="total">
      <span class="total-label">${e(text.totalLabel)}</span>
      ${totalBlock}
    </div>

    <div class="footer">
      <div class="note">${e(text.footerNote)}</div>
      <div class="fcontact">${contactLine}</div>
    </div>
  </div>
</body>
</html>`
}
