'use client'

/**
 * The public real-time price calculator (Phase 3 — FUNCTIONALITY §3.3, TECHSPEC §6.3).
 *
 * Replaces the Phase 2 static, disabled preview with live inputs: as the visitor
 * changes any field the estimated total recomputes on every change (no submit
 * button), using the SAME pure evaluator (`@/lib/pricing`) that runs server-side
 * and in the Phase 4 PDF — so the on-screen price can never drift from the quote.
 *
 * The zero/negative-total edge case (§7) renders "Contact us for a price" instead
 * of a number. The price is an `aria-live` region so assistive tech announces
 * each recalculation. Inputs are keyboard-native (`<input>`/`<select>`/checkbox).
 *
 * The **Download PDF** action (Phase 4 part 1, FUNCTIONALITY §3.3/§4) posts the
 * current inputs to `/api/quote`, which re-prices authoritatively server-side and
 * returns a branded PDF. It's available regardless of whether every field is
 * filled (§3.3); required gaps are already indicated by the total's gating.
 * Send-to-Email is Phase 4 part 2 (blocked on a verified SES identity).
 */

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { Download, Info } from '@/components/site/icons'
import {
  coerceInputs,
  computePrice,
  formatCurrency,
  type JsonLogic,
  type PricingField,
  type RawInput,
} from '@/lib/pricing'

function initialValues(fields: PricingField[]): Record<string, RawInput> {
  const out: Record<string, RawInput> = {}
  for (const f of fields) {
    if (f.type === 'toggle') out[f.fieldKey] = false
    else if (f.type === 'dropdown') out[f.fieldKey] = String(f.options[0]?.value ?? 0)
    else out[f.fieldKey] = '' // number: start blank
  }
  return out
}

export function ServiceCalculator({
  fields,
  formula,
  slug,
  phone,
  email,
}: {
  fields: PricingField[]
  formula: JsonLogic | null
  slug: string
  phone?: string | null
  email?: string | null
}) {
  const t = useTranslations('Service')
  const locale = useLocale()
  const [values, setValues] = useState<Record<string, RawInput>>(() =>
    initialValues(fields),
  )
  const [downloading, setDownloading] = useState(false)
  // null = no error; 'rateLimited' = HTTP 429 (too many quotes, distinct copy);
  // 'generic' = any other failure (network/server) with the phone/email fallback.
  const [downloadError, setDownloadError] = useState<null | 'generic' | 'rateLimited'>(null)

  const setField = (key: string, value: RawInput) =>
    setValues((prev) => ({ ...prev, [key]: value }))

  async function handleDownload() {
    if (downloading) return
    setDownloading(true)
    setDownloadError(null)
    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, locale, inputs: values }),
      })
      if (res.status === 429) {
        setDownloadError('rateLimited')
        return
      }
      if (!res.ok) throw new Error(`quote request failed: ${res.status}`)

      const blob = await res.blob()
      const contentType = res.headers.get('Content-Type') ?? ''
      const url = URL.createObjectURL(blob)

      if (contentType.includes('application/pdf')) {
        // Parse the server-provided filename; fall back to a sensible default.
        const disposition = res.headers.get('Content-Disposition') ?? ''
        const match = /filename="([^"]+)"/.exec(disposition)
        const a = document.createElement('a')
        a.href = url
        a.download = match?.[1] ?? `quote-${slug}.pdf`
        document.body.appendChild(a)
        a.click()
        a.remove()
      } else {
        // Local/CI HTML-preview fallback (no PDF backend): open for inspection.
        window.open(url, '_blank', 'noopener')
      }
      // Give the browser a tick to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      console.error('[calculator] PDF download failed:', err)
      setDownloadError('generic')
    } finally {
      setDownloading(false)
    }
  }

  const inputs = useMemo(() => coerceInputs(fields, values), [fields, values])
  const result = useMemo(
    () => computePrice({ fields, formula, inputs }),
    [fields, formula, inputs],
  )

  // Required number fields left blank — flagged so the visitor knows the estimate
  // is incomplete (FUNCTIONALITY §3.3: empty/invalid fields clearly indicated).
  const missingRequired = fields.filter(
    (f) => f.required && f.type === 'number' && (values[f.fieldKey] === '' ||
      values[f.fieldKey] === null || values[f.fieldKey] === undefined),
  )

  // A total is only meaningful once every required field has a value. An
  // explicit 0 counts as filled; only an untouched/blank field is "missing".
  const hasAllRequired = missingRequired.length === 0
  const showContributions = !result.usedFormula
  const hasAnyContribution =
    hasAllRequired && result.lineItems.some((li) => li.contribution !== null)

  return (
    <>
      <div className="calc-wrapper">
        <div className="calc-header">
          <span className="calc-header-label">{t('calcHeaderLabel')}</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--g400)' }}>
            {t('calcHeaderHint')}
          </span>
        </div>

        {fields.map((field, i) => {
          const id = `f_${field.fieldKey}`
          const isMissing = missingRequired.some((m) => m.fieldKey === field.fieldKey)
          return (
            <div
              className="calc-row"
              key={field.fieldKey}
              style={i === fields.length - 1 ? { borderBottom: 'none' } : undefined}
            >
              <label className="calc-label" htmlFor={id}>
                {field.label}
                {field.required ? (
                  <span className="form-required" aria-hidden="true">
                    {' '}*
                  </span>
                ) : null}
                {field.required ? (
                  <span className="visually-hidden"> ({t('requiredMark')})</span>
                ) : null}
              </label>
              <div className="calc-control">
                {field.type === 'number' && (
                  <input
                    id={id}
                    className="calc-input"
                    type="number"
                    inputMode="decimal"
                    value={(values[field.fieldKey] as string) ?? ''}
                    placeholder="0"
                    aria-invalid={isMissing || undefined}
                    onChange={(e) => setField(field.fieldKey, e.target.value)}
                  />
                )}
                {field.type === 'dropdown' && (
                  <select
                    id={id}
                    className="calc-select"
                    value={(values[field.fieldKey] as string) ?? ''}
                    onChange={(e) => setField(field.fieldKey, e.target.value)}
                  >
                    {field.options.map((opt, oi) => (
                      <option key={oi} value={String(opt.value)}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                )}
                {field.type === 'toggle' && (
                  // A <label> (not a <span>) so a click anywhere on the visible
                  // slider toggles the 0×0 hidden checkbox nested inside it.
                  <label className="toggle">
                    <input
                      id={id}
                      type="checkbox"
                      checked={!!values[field.fieldKey]}
                      onChange={(e) => setField(field.fieldKey, e.target.checked)}
                    />
                    <span className="toggle-slider" aria-hidden="true" />
                  </label>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Prominent live total (FUNCTIONALITY §3.3) — an aria-live region so the
          recalculated price is announced to assistive technology. The total is
          withheld (a prompt shown instead) until all required fields are filled. */}
      <div className="price-box" style={{ marginTop: '1.5rem' }}>
        <div className="price-tag">{t('priceTag')}</div>
        {!hasAllRequired ? (
          <div
            aria-live="polite"
            data-testid="calc-total"
            style={{ color: 'var(--g400)', fontSize: '1.05rem', fontWeight: 500, lineHeight: 1.5 }}
          >
            {t('enterRequired')}
          </div>
        ) : (
          <>
            <div className="price-amount" aria-live="polite" data-testid="calc-total">
              {result.kind === 'price'
                ? formatCurrency(result.total, locale)
                : t('contactForQuote')}
            </div>
            <p className="price-note">
              {result.kind === 'price' ? t('priceNote') : t('contactNote')}
            </p>
          </>
        )}
      </div>

      {/* Quote actions (FUNCTIONALITY §3.3/§4). Download is available regardless of
          field completeness; the server re-prices authoritatively and returns a
          branded PDF (or, on a stage with no PDF backend, the HTML for preview). */}
      <div className="calc-actions" style={{ marginTop: '1.5rem' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleDownload}
          disabled={downloading}
          aria-busy={downloading || undefined}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Download width={16} height={16} strokeWidth={2} />
          {downloading ? t('downloadPreparing') : t('downloadPdf')}
        </button>
        {downloadError && (
          <p className="price-note" role="alert" style={{ color: 'var(--orange)', marginTop: '0.75rem' }}>
            {downloadError === 'rateLimited'
              ? t('downloadRateLimited')
              : t('downloadError', { phone: phone ?? '—', email: email ?? '—' })}
          </p>
        )}
      </div>

      {/* Estimate breakdown (FUNCTIONALITY §4 line items). Contribution amounts are
          shown only for the default (non-formula) total, where they sum to it. */}
      {hasAnyContribution && (
        <div className="calc-breakdown" style={{ marginTop: '1.5rem' }}>
          <div className="calc-header" style={{ background: 'var(--g100)' }}>
            <span
              className="calc-header-label"
              style={{ color: 'var(--g600)' }}
            >
              {t('breakdownTitle')}
            </span>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {result.lineItems.map((li) => (
              <li
                key={li.fieldKey}
                className="calc-row"
                style={{ fontSize: '0.875rem' }}
              >
                <span style={{ color: 'var(--g700)', flex: 1, minWidth: 160 }}>
                  {li.label}
                </span>
                <span style={{ color: 'var(--g600)', fontWeight: 500 }}>
                  {showContributions && li.contribution !== null
                    ? formatCurrency(li.contribution, locale)
                    : String(li.value)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Estimate disclaimer repeated AFTER the calculator (FUNCTIONALITY §3.3:
          shown before AND after). */}
      <div className="disclaimer" style={{ marginTop: '1.5rem' }} role="note">
        <Info />
        <div className="disclaimer-text">{t('estimateAfterNote')}</div>
      </div>
    </>
  )
}
