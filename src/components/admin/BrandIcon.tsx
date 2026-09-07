import React from 'react'

/**
 * Admin nav icon (admin.components.graphics.Icon) — the compact square Bulbau
 * mark in the sidebar header, mirroring the public site's `.logo-mark` (orange
 * square, white "B" in the condensed display face). Self-contained inline styles
 * (the public CSS classes aren't loaded in the admin); it only leans on the
 * Barlow font that src/app/(payload)/custom.scss loads, with a system fallback.
 */
export default function BrandIcon() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        background: '#BF4C00',
        color: '#ffffff',
        fontFamily: "'Barlow Condensed', 'Arial Narrow', sans-serif",
        fontWeight: 900,
        fontSize: '1.15rem',
        lineHeight: 1,
        letterSpacing: '-0.02em',
      }}
    >
      B
    </span>
  )
}
