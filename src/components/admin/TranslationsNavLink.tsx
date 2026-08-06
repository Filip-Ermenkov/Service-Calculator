import type { ServerProps } from 'payload'

/**
 * A nav link to the custom Translation Management view (Phase 5 part 2),
 * injected via admin.components.afterNavLinks (see payload.config.ts). Rendered
 * inside Payload's own <Nav>, so it reuses Payload's `nav__link` markup/classes
 * to match the built-in collection/global links visually.
 *
 * It's a plain server component (afterNavLinks receives ServerProps): a static
 * anchor is all a nav link needs, and an <a> gives a full document load into the
 * custom Root View, which is the safe, framework-agnostic choice (no dependency
 * on the admin SPA router internals).
 */
export default function TranslationsNavLink({ payload }: ServerProps) {
  const adminRoute = payload?.config?.routes?.admin || '/admin'
  const href = `${adminRoute.replace(/\/$/, '')}/translations`

  return (
    <a className="nav__link" href={href}>
      <span className="nav__link-label">Translations</span>
    </a>
  )
}
