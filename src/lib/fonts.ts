import localFont from 'next/font/local'

/**
 * The site's two typefaces, used by both root layouts (the public site in
 * src/app/[locale]/layout.tsx and the admin in src/app/(payload)/layout.tsx),
 * exposed as the CSS variables globals.css and custom.scss read.
 *
 * LOCAL files, not `next/font/google`. Both serve the fonts from our own
 * origin, but `next/font/google` downloads them from Google during EVERY build,
 * and Google's font service refusing that download failed three CI builds in a
 * single day (2026-10-29/30), each time blocking a deploy. The files now come
 * from the @fontsource npm packages, so a build needs the npm registry it
 * already depends on and nothing else.
 *
 * Inter is the variable font: one file covers every weight either layout uses
 * (300–900). Barlow Condensed has no variable build, so it is one file per
 * weight in use (500–900). Latin only, as before: it covers English, French and
 * German, accents included.
 *
 * next/font requires these options to be literal values, which is why the
 * Barlow files are listed out rather than generated.
 */
export const inter = localFont({
  src: '../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-inter',
  display: 'swap',
})

export const barlow = localFont({
  src: [
    {
      path: '../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-500-normal.woff2',
      weight: '500',
      style: 'normal',
    },
    {
      path: '../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2',
      weight: '600',
      style: 'normal',
    },
    {
      path: '../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2',
      weight: '700',
      style: 'normal',
    },
    {
      path: '../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2',
      weight: '800',
      style: 'normal',
    },
    {
      path: '../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-900-normal.woff2',
      weight: '900',
      style: 'normal',
    },
  ],
  variable: '--font-barlow',
  display: 'swap',
})
