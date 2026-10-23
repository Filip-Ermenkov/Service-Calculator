/**
 * Generates the site's static brand files into `public/`:
 *
 *   favicon.ico            16 + 32 + 48 px, for browsers and tools that only look there
 *   icon.svg               the scalable tab icon modern browsers prefer
 *   apple-touch-icon.png   180 px, opaque (iOS ignores transparency)
 *   icon-192.png / icon-512.png   for site.webmanifest
 *   og-image.png           1200 × 630 share card (Open Graph / Twitter)
 *
 *   node scripts/generate-brand-assets.mjs
 *
 * The mark is the same one the site header draws in CSS (`.logo-mark` in
 * src/app/[locale]/globals.css): a white "B" on a `--orange` square. The letter
 * is a PATH, not text, so every output is identical on every machine; a font
 * would render differently wherever the script runs. The share card's words do
 * use a font, but they are rasterised here once and committed, so visitors never
 * depend on it either.
 *
 * If the client supplies a real logo, replace MARK_PATH (or the whole SVGs) and
 * re-run; nothing else references these files' contents.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'public')
mkdirSync(out, { recursive: true })

// Brand colours, mirrored from the :root tokens in globals.css.
const ORANGE = '#BF4C00'
const BLACK = '#0A0A0A'
const WHITE = '#FFFFFF'
const GREY = '#9CA3AF'

// A heavy, slightly condensed "B" in a 100 × 100 box: an outer outline plus two
// counters, filled even-odd so the counters punch through.
const MARK_PATH =
  'M26 18H55C66 18 72 24 72 33C72 39 69 44 64 46C71 48 75 54 75 62C75 74 68 82 55 82H26Z' +
  'M39 29H53C57 29 59 31 59 34.5C59 38 57 40 53 40H39Z' +
  'M39 51H54C59.5 51 62 54 62 61C62 68 59.5 71 54 71H39Z'

/** The square mark as a standalone SVG. `rounded` softens corners for app icons. */
function markSvg({ size, rounded = false }) {
  const r = rounded ? 18 : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${r}" fill="${ORANGE}"/>
  <path d="${MARK_PATH}" fill="${WHITE}" fill-rule="evenodd"/>
</svg>
`
}

async function png(svg, size) {
  return sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer()
}

/** Packs PNG images into one .ico (the format allows embedded PNGs since Vista). */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, data } of images) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // no palette
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

function ogSvg() {
  // Faint 40 px grid, the same texture as the site's dark `.grid-bg` sections.
  const lines = []
  for (let x = 40; x < 1200; x += 40) lines.push(`<path d="M${x} 0V630" />`)
  for (let y = 40; y < 630; y += 40) lines.push(`<path d="M0 ${y}H1200" />`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BLACK}"/>
  <g stroke="${WHITE}" stroke-opacity="0.05" stroke-width="1">${lines.join('')}</g>
  <rect x="0" y="0" width="12" height="630" fill="${ORANGE}"/>
  <g transform="translate(96 150) scale(1.6)">
    <rect width="100" height="100" fill="${ORANGE}"/>
    <path d="${MARK_PATH}" fill="${WHITE}" fill-rule="evenodd"/>
  </g>
  <text x="300" y="262" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900"
        font-size="104" letter-spacing="10" fill="${WHITE}">BULBAU</text>
  <text x="96" y="420" font-family="Arial, Helvetica, sans-serif" font-weight="700"
        font-size="46" fill="${WHITE}">Energy &amp; Building Services</text>
  <text x="96" y="482" font-family="Arial, Helvetica, sans-serif" font-size="34"
        fill="${GREY}">Luxembourg · bulbau.lu</text>
</svg>
`
}

const square = markSvg({ size: 512 })
const rounded = markSvg({ size: 512, rounded: true })

writeFileSync(path.join(out, 'icon.svg'), markSvg({ size: 32 }))
writeFileSync(
  path.join(out, 'favicon.ico'),
  ico(
    await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(square, size) }))),
  ),
)
writeFileSync(path.join(out, 'apple-touch-icon.png'), await png(square, 180))
writeFileSync(path.join(out, 'icon-192.png'), await png(rounded, 192))
writeFileSync(path.join(out, 'icon-512.png'), await png(rounded, 512))
writeFileSync(
  path.join(out, 'og-image.png'),
  await sharp(Buffer.from(ogSvg())).png({ compressionLevel: 9 }).toBuffer(),
)
console.log('brand assets written to public/')
