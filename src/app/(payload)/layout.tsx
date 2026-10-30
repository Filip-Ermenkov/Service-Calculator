/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */
import config from '@payload-config'
import '@payloadcms/next/css'
import type { ServerFunctionClient } from 'payload'
import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import React from 'react'

import { barlow, inter } from '@/lib/fonts'

import { importMap } from './admin/importMap.js'
import './custom.scss'

// The admin's two typefaces, SELF-HOSTED exactly like the public site's and
// from the same module (src/lib/fonts.ts): served from this origin, and built
// from local files, never fetched from Google. Until 2026-09-18 custom.scss
// pulled them from fonts.googleapis.com at runtime, a third-party request (and
// the admin's IP) leaving for Google on every admin page. They are exposed as
// the CSS variables custom.scss reads: `var(--font-inter)`/`var(--font-barlow)`.

type Args = {
  children: React.ReactNode
}

const serverFunction: ServerFunctionClient = async function (args) {
  'use server'
  return handleServerFunctions({
    ...args,
    config,
    importMap,
  })
}

const Layout = ({ children }: Args) => (
  <RootLayout
    config={config}
    importMap={importMap}
    serverFunction={serverFunction}
    // Payload spreads these onto its <html>, which is where next/font's
    // `variable` classes must live for the CSS variables to reach everything —
    // including the modals and toasts Payload portals to <body>.
    htmlProps={{ className: `${inter.variable} ${barlow.variable}` }}
  >
    {children}
  </RootLayout>
)

export default Layout
