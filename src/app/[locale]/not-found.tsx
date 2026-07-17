import { Link } from '@/i18n/navigation'

/**
 * Localized-shell 404. Rendered inside the `[locale]` layout (so it keeps the
 * header/footer) for any unmatched path under a valid locale — the proxy
 * redirects bogus top segments to `/<locale>/…` first, so the locale context is
 * always present here. Text is kept static (no next-intl hooks) to stay robust;
 * the home link uses the locale-aware `Link`.
 */
export default function NotFound() {
  return (
    <section className="section bg-white">
      <div className="container" style={{ textAlign: 'center', padding: '5rem 1.5rem' }}>
        <span className="eyebrow">404</span>
        <h1 className="display-lg" style={{ display: 'inline-block' }}>
          Page not found
        </h1>
        <p style={{ color: 'var(--g500)', marginTop: '1rem', marginBottom: '2rem' }}>
          Sorry, we couldn’t find the page you were looking for.
        </p>
        <Link href="/" className="btn btn-primary btn-lg">
          Back to home
        </Link>
      </div>
    </section>
  )
}
