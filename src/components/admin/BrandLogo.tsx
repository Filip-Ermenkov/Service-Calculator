import React from 'react'

/**
 * Admin login logo (admin.components.graphics.Logo) — the full Bulbau wordmark
 * on the login screen, mirroring the public header: the orange square "B" mark
 * beside the "BULBAU" wordmark, with an "Admin Panel" sublabel so the private
 * CMS reads distinctly from the public site. Self-contained inline styles; only
 * leans on the Barlow display font loaded by src/app/(payload)/custom.scss.
 */
export default function BrandLogo() {
  const display = "'Barlow Condensed', 'Arial Narrow', sans-serif"
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          height: 44,
          background: '#BF4C00',
          color: '#ffffff',
          fontFamily: display,
          fontWeight: 900,
          fontSize: '1.5rem',
          lineHeight: 1,
          letterSpacing: '-0.02em',
        }}
      >
        B
      </span>
      <span
        style={{
          fontFamily: display,
          fontWeight: 800,
          fontSize: '1.65rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        Bulbau
      </span>
    </span>
  )
}
