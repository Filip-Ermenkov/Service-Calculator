import React from 'react'

/**
 * The prototype's top-bar action (/prototype/admin/*.html): a dark "View
 * website" button sitting at the right of the admin header on every screen.
 *
 * Registered as `admin.components.actions` in payload.config.ts, which Payload
 * renders into `.app-header__actions` on EVERY view — so it appears once, in the
 * one place the prototype puts it, instead of being repeated per screen.
 *
 * Plain server component: it is a link, nothing more. Styled by `.atopbar-link`
 * in custom.scss, which collapses it to an icon-only square on phones so it
 * never crowds the page title.
 */
export default function ViewWebsiteAction() {
  return (
    <a className="atopbar-link" href="/" target="_blank" rel="noopener noreferrer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
      </svg>
      <span>View website</span>
    </a>
  )
}
