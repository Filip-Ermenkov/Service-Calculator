import React from 'react'

/**
 * Rendered via admin.components.beforeLogin — the "Admin Login" heading above
 * the Payload login fields (the Bulbau wordmark itself comes from BrandLogo in
 * graphics.Logo). Styled by `.admin-login-intro` in custom.scss.
 */
export default function LoginIntro() {
  return (
    <div className="admin-login-intro">
      <h2 className="admin-login-intro__title">Admin Login</h2>
      <p className="admin-login-intro__text">Enter your credentials to access the admin panel.</p>
    </div>
  )
}
