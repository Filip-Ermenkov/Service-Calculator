'use client'

/**
 * Cloudflare Turnstile client widget (Phase 6 — FUNCTIONALITY §6, TECHSPEC §6.8).
 *
 * Renders the Turnstile challenge and reports the resulting token up to the
 * parent form via `onToken`. The server (src/lib/security/turnstile.ts) is the
 * real authority — this widget just produces the token the server verifies.
 *
 * ENV-GATED on the PUBLIC site key (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, inlined at
 * build by Next). When it's unset — local dev, CI, any stage without Turnstile —
 * this renders NOTHING and the form treats "no token required" (the matching
 * server module also skips verification when its secret is unset). So the whole
 * feature is a clean no-op off a stage that hasn't provisioned Turnstile, exactly
 * like the SES/CDN/translate modules.
 *
 * Uses EXPLICIT rendering (`api.js?render=explicit` + `turnstile.render`) rather
 * than the implicit `class="cf-turnstile"` auto-scan, because this is a
 * client-rendered React form: explicit rendering gives a stable widget id for
 * reset() after a failed submit and a callback that flows the token into React
 * state, instead of a hidden input the auto-scan would populate.
 */

import { useEffect, useRef } from 'react'

/** Public site key (safe to expose; the secret stays server-side). */
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      action?: string
      language?: string
      callback?: (token: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
      'timeout-callback'?: () => void
    },
  ) => string
  reset: (id?: string) => void
  remove: (id?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

/** True when Turnstile is configured for this build (the widget will render). */
export function isTurnstileEnabled(): boolean {
  return Boolean(SITE_KEY)
}

// Load the Turnstile script exactly once per page, shared across widgets.
let scriptPromise: Promise<void> | null = null
function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Turnstile script failed to load'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

export function TurnstileWidget({
  onToken,
  action,
  locale,
  resetSignal,
}: {
  /** Called with the token on success, or null when it expires/errors/resets. */
  onToken: (token: string | null) => void
  /** Optional action label (surfaced in Cloudflare analytics). */
  action?: string
  /** Widget UI language (matches the page locale). */
  locale?: string
  /** Increment to force a reset (e.g. after a rejected submit consumes the token). */
  resetSignal?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  // Keep the latest onToken without re-rendering the widget on every parent render.
  // Synced in an effect (not during render) so it doesn't touch a ref mid-render;
  // the initial useRef value already covers the widget's first (async) callbacks.
  const onTokenRef = useRef(onToken)
  useEffect(() => {
    onTokenRef.current = onToken
  }, [onToken])

  // Render the widget once on mount (action/locale are stable for a form's life).
  useEffect(() => {
    if (!SITE_KEY) return
    let cancelled = false
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return
        if (widgetIdRef.current) return
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          action,
          language: locale,
          callback: (token) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
          'timeout-callback': () => onTokenRef.current(null),
        })
      })
      .catch(() => {
        // Script blocked/failed: leave the widget absent. The submit will have no
        // token; the server returns turnstile_failed and the UI asks to retry.
      })
    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reset on demand (parent bumps resetSignal after a failed/consumed submit).
  useEffect(() => {
    if (resetSignal === undefined || resetSignal === 0) return
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current)
      onTokenRef.current(null)
    }
  }, [resetSignal])

  if (!SITE_KEY) return null
  return <div ref={containerRef} className="turnstile-widget" style={{ marginTop: '0.75rem' }} />
}
