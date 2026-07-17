import { getRequestConfig } from 'next-intl/server'
import { hasLocale } from 'next-intl'

import { routing } from './routing'

/**
 * Per-request i18n configuration consumed by next-intl's server APIs.
 *
 * Returning `locale` is required in next-intl v4 — without it the library can't
 * determine the active locale. Messages are the UI-chrome catalogs (not CMS
 * content, which comes from Payload); an unknown/absent locale falls back to the
 * default so a mis-routed request can never crash the render.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  }
})
