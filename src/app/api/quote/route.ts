/**
 * On-demand PDF quote generation (Phase 4 — FUNCTIONALITY §4, TECHSPEC §6.5).
 *
 * POST /api/quote  { slug, locale, inputs }
 *
 * The visitor's browser posts the current calculator inputs; the server re-loads
 * the **authoritative** service (published-only, via the same access-gated data
 * layer as every public read — the client's field/price data is never trusted),
 * assembles the quote in the requested language, renders the branded HTML, and
 * hands it to the isolated PDF Lambda. The PDF is streamed straight back for
 * download and **never persisted** (FUNCTIONALITY §4 / TECHSPEC §12).
 *
 * This route lives outside the `[locale]` segment (locale travels in the body),
 * so next-intl's middleware never rewrites it; `/api/*` is also excluded from the
 * admin proxy. Email delivery (SES) is Phase 4 part 2 and intentionally absent.
 */

import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'

import { routing, type Locale } from '@/i18n/routing'
import { getCompanyInfo, getServiceBySlug } from '@/lib/content'
import { buildQuoteModel, type QuoteText } from '@/lib/pdf/quote'
import { renderPdf } from '@/lib/pdf/render'
import { renderQuoteHtml } from '@/lib/pdf/template'
import { toPricingFields, type JsonLogic, type RawInput } from '@/lib/pricing'
import { checkRateLimit, getClientIp, type RateLimitPolicy } from '@/lib/rateLimit'

interface QuoteRequestBody {
  slug?: unknown
  locale?: unknown
  inputs?: unknown
}

/**
 * Rate limit for the public PDF endpoint. Each allowed call re-loads the service
 * from Neon and invokes the isolated 1600 MB Chromium Lambda, so this is an
 * expensive, unauthenticated resource — the limit caps AWS cost/DoS exposure
 * (Well-Architected Security + Cost). 10 / minute / IP is generous for a real
 * visitor tweaking inputs and re-downloading, while stopping a scripted loop.
 */
const QUOTE_RATE_LIMIT: RateLimitPolicy = {
  prefix: 'bulbau-quote',
  max: 10,
  windowSeconds: 60,
}

/**
 * Hard caps on the request itself (App Router route handlers can't declaratively
 * bound body size). The quote body is a tiny `{ slug, locale, inputs }` JSON —
 * a few hundred bytes in practice — so anything large is abuse. Reject early to
 * avoid parsing/holding a big payload in the Lambda's memory.
 */
const MAX_BODY_BYTES = 16 * 1024 // 16 KB
const MAX_INPUT_FIELDS = 200 // far above any real calculator's field count

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (routing.locales as readonly string[]).includes(value)
}

export async function POST(request: Request) {
  // 1) Reject oversized payloads before reading the body (defence-in-depth: a
  //    missing/lying Content-Length still can't exceed the platform's own limit,
  //    and the field-count guard below bounds the parsed object regardless).
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
  }

  // 2) Rate-limit by client IP BEFORE any expensive work (no body read, no DB,
  //    no Lambda). A blocked caller gets 429 + Retry-After and nothing else runs.
  const ip = getClientIp(request)
  const rate = await checkRateLimit(QUOTE_RATE_LIMIT, ip)
  if (!rate.success) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(QUOTE_RATE_LIMIT.windowSeconds) } },
    )
  }

  let body: QuoteRequestBody
  try {
    body = (await request.json()) as QuoteRequestBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { slug } = body
  const locale = isLocale(body.locale) ? body.locale : routing.defaultLocale
  if (typeof slug !== 'string' || slug.length === 0) {
    return NextResponse.json({ error: 'missing_slug' }, { status: 400 })
  }

  // Raw inputs are an untrusted string/bool/number map keyed by fieldKey. Coerce
  // to a plain record; the pricing layer sanitises every value downstream.
  const rawInputs: Record<string, RawInput> =
    body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
      ? (body.inputs as Record<string, RawInput>)
      : {}

  // Bound the parsed input map — a huge object would only ever be abuse (the
  // authoritative field list comes from the CMS, not the client, so extra keys
  // are ignored downstream anyway; this just refuses to process an absurd one).
  if (Object.keys(rawInputs).length > MAX_INPUT_FIELDS) {
    return NextResponse.json({ error: 'too_many_fields' }, { status: 400 })
  }

  try {
    const service = await getServiceBySlug(slug, locale)
    if (!service) {
      return NextResponse.json({ error: 'service_not_found' }, { status: 404 })
    }

    const fields = toPricingFields(service.calculatorFields)
    const formula = (service.formula ?? null) as JsonLogic | null
    const company = await getCompanyInfo(locale)

    const t = await getTranslations({ locale, namespace: 'Quote' })
    const tMeta = await getTranslations({ locale, namespace: 'Metadata' })

    const text: QuoteText = {
      title: t('title'),
      disclaimerTitle: t('disclaimerTitle'),
      disclaimerBody: t('disclaimerBody'),
      serviceLabel: t('serviceLabel'),
      dateLabel: t('dateLabel'),
      paramColumn: t('paramColumn'),
      valueColumn: t('valueColumn'),
      priceColumn: t('priceColumn'),
      totalLabel: t('totalLabel'),
      contactForPrice: t('contactForPrice'),
      footerNote: t('footerNote'),
      phoneLabel: t('phoneLabel'),
      emailLabel: t('emailLabel'),
      notSpecified: t('notSpecified'),
      yes: t('yes'),
      no: t('no'),
    }

    const model = buildQuoteModel({
      fields,
      formula,
      rawInputs,
      locale,
      company: {
        name: tMeta('siteName'),
        phone: company?.phone ?? null,
        email: company?.email ?? null,
      },
      text,
      serviceTitle: service.title ?? slug,
    })

    const html = renderQuoteHtml(model)
    const dateStamp = new Date().toISOString().slice(0, 10)
    const filename = `quote-${slug}-${dateStamp}.pdf`

    const rendered = await renderPdf(html)

    // No PDF backend on this stage (local dev / CI): serve the HTML so the
    // template can still be viewed and browser-printed. Flagged via a header.
    if (!rendered) {
      return new NextResponse(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Pdf-Preview': 'html',
          'Cache-Control': 'no-store',
        },
      })
    }

    return new NextResponse(new Uint8Array(rendered.buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(rendered.buffer.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('[api/quote] PDF generation failed:', err)
    return NextResponse.json({ error: 'pdf_generation_failed' }, { status: 502 })
  }
}
