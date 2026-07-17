/**
 * Minimal root layout for the bare `/` route ONLY.
 *
 * The real, localized public site lives under `src/app/[locale]/` with its own
 * (locale-aware) root layout. This file exists because the Phase 0 placeholder
 * that used to live here can't be deleted from the build sandbox (the Windows
 * mount is read-only to deletes — see docs/PROGRESS.md "Environment quirks"), so
 * it is repurposed into a valid, chrome-free root that backs the `/ → /<locale>`
 * redirect in `page.tsx`. In practice the proxy (src/proxy.ts) redirects `/`
 * before this ever renders.
 */
import type { ReactNode } from 'react'

export default function RootRedirectLayout({
  children,
}: {
  children: ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
