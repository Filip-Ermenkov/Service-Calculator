import Link from 'next/link'
import React from 'react'

/**
 * Rendered via admin.components.afterLogin — a "Back to website" link below the
 * login card (matching the prototype). Styled by `.admin-login-back`.
 */
export default function BackToWebsite() {
  return (
    <div className="admin-login-back">
      <Link href="/">&larr; Back to website</Link>
    </div>
  )
}
