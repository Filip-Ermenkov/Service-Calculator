/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */
import config from '@payload-config'
import '@payloadcms/next/css'
import type { ServerFunctionClient } from 'payload'
import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import { Barlow_Condensed, Inter } from 'next/font/google'
import React from 'react'

import { importMap } from './admin/importMap.js'
import './custom.scss'

// The admin's two typefaces, SELF-HOSTED through next/font exactly like the
// public site's (src/app/[locale]/layout.tsx): the files are downloaded once at
// build time and served from this origin. Until 2026-09-18 custom.scss pulled
// them from fonts.googleapis.com at runtime — a third-party request (and the
// admin's IP) leaving for Google on every admin page, which the public site had
// deliberately avoided. The weights are the admin's own set (custom.scss uses
// 400–800 body, 600–900 display), exposed as the same CSS-variable names the
// public site uses so custom.scss reads `var(--font-inter)`/`var(--font-barlow)`.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-inter',
  display: 'swap',
})
const barlow = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['600', '700', '800', '900'],
  variable: '--font-barlow',
  display: 'swap',
})

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
