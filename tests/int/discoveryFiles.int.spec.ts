import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { DEFAULT_SHARE_IMAGE, businessJsonLd, pageMetadata, postalAddress } from '@/lib/seo'

// The files crawlers, browsers and security researchers look for at fixed
// places (public/), and the structured data the Home page publishes. Pure: no
// database, no server. The e2e suite proves the same files are SERVED.

const PUBLIC = path.join(process.cwd(), 'public')
const read = (p: string) => readFileSync(path.join(PUBLIC, p), 'utf8')

describe('security.txt (RFC 9116)', () => {
  const text = read('.well-known/security.txt')
  const fields = new Map<string, string[]>()
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim())
    if (m) fields.set(m[1].toLowerCase(), [...(fields.get(m[1].toLowerCase()) ?? []), m[2].trim()])
  }

  it('has the two required fields, Expires exactly once', () => {
    expect(fields.get('contact')?.length).toBeGreaterThan(0)
    expect(fields.get('expires')).toHaveLength(1)
  })

  it('every Contact is a URI the RFC allows', () => {
    for (const c of fields.get('contact') ?? []) expect(c).toMatch(/^(https:\/\/|mailto:|tel:)/)
  })

  it('names its canonical URL on the production origin', () => {
    expect(fields.get('canonical')).toEqual(['https://bulbau.lu/.well-known/security.txt'])
  })

  // RFC 9116 §2.5.5: a file past its Expires date must be treated as stale.
  // This fails a month ahead, so renewing it is a routine one-line PR, not an
  // outage. To renew: set Expires to about 11 months from today.
  it('is not within 30 days of expiring', () => {
    const expires = Date.parse((fields.get('expires') ?? [''])[0])
    expect(Number.isNaN(expires)).toBe(false)
    const days = (expires - Date.now()) / 86_400_000
    expect(
      days,
      'public/.well-known/security.txt expires soon: renew the Expires field',
    ).toBeGreaterThan(30)
    // The RFC recommends less than a year ahead.
    expect(days).toBeLessThan(366)
  })
})

describe('brand files in public/', () => {
  it.each([
    ['apple-touch-icon.png', 180, 180],
    ['icon-192.png', 192, 192],
    ['icon-512.png', 512, 512],
    ['og-image.png', DEFAULT_SHARE_IMAGE.width, DEFAULT_SHARE_IMAGE.height],
  ])('%s is a %ix%i PNG', async (file, width, height) => {
    const meta = await sharp(path.join(PUBLIC, file)).metadata()
    expect(meta.format).toBe('png')
    expect([meta.width, meta.height]).toEqual([width, height])
  })

  it('favicon.ico is an icon file and icon.svg an SVG', () => {
    const ico = readFileSync(path.join(PUBLIC, 'favicon.ico'))
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1])
    expect(ico.readUInt16LE(4)).toBeGreaterThan(0)
    expect(read('icon.svg')).toMatch(/^<svg[\s\S]*<\/svg>\s*$/)
  })

  it('the share image the metadata points at exists', () => {
    expect(existsSync(path.join(PUBLIC, DEFAULT_SHARE_IMAGE.url))).toBe(true)
  })

  it('site.webmanifest only lists icons that exist', () => {
    const manifest = JSON.parse(read('site.webmanifest')) as { icons: { src: string }[] }
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) expect(existsSync(path.join(PUBLIC, icon.src))).toBe(true)
  })
})

describe('share metadata (src/lib/seo.ts)', () => {
  it('falls back to the default share card when a page has no photo', () => {
    const meta = pageMetadata({ locale: 'en', path: '/about', description: 'x' })
    expect(meta.openGraph?.images).toEqual([{ ...DEFAULT_SHARE_IMAGE }])
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image' })
  })

  it("keeps a page's own photo when it has one", () => {
    const meta = pageMetadata({ locale: 'en', path: '/services/x', images: ['/media/a/b.jpg'] })
    expect(meta.openGraph?.images).toEqual(['/media/a/b.jpg'])
  })
})

describe('business structured data (src/lib/seo.ts)', () => {
  it('splits a Luxembourg address into PostalAddress fields', () => {
    expect(postalAddress('3 Rue des Genets, 1621 Luxembourg')).toEqual({
      '@type': 'PostalAddress',
      streetAddress: '3 Rue des Genets',
      postalCode: '1621',
      addressLocality: 'Luxembourg',
      addressCountry: 'LU',
    })
    expect(postalAddress('12 rue X, L-4001 Esch-sur-Alzette')).toMatchObject({
      postalCode: '4001',
      addressLocality: 'Esch-sur-Alzette',
    })
  })

  it('keeps an address it cannot parse whole instead of guessing', () => {
    expect(postalAddress('Zone industrielle, Bâtiment B')).toEqual({
      '@type': 'PostalAddress',
      streetAddress: 'Zone industrielle, Bâtiment B',
      addressCountry: 'LU',
    })
  })

  const legal = {
    _status: 'published',
    legalName: 'BULBAU MULTISERVICE',
    legalForm: 'S.A.S',
    registeredAddress: '3 Rue des Genets, 1621 Luxembourg',
    vatNumber: 'LU37807402',
  }

  it('publishes the registered details once the Legal Notice is published', () => {
    const data = businessJsonLd({
      locale: 'fr',
      company: {
        email: 'office@bulbau.lu',
        phone: '+352 1',
        facebookUrl: 'https://facebook.com/x',
      },
      legal,
    })
    expect(data).toMatchObject({
      '@type': 'HomeAndConstructionBusiness',
      legalName: 'BULBAU MULTISERVICE S.A.S',
      vatID: 'LU37807402',
      address: { postalCode: '1621' },
      email: 'office@bulbau.lu',
      telephone: '+352 1',
      sameAs: ['https://facebook.com/x'],
    })
    expect(data.url).toMatch(/\/fr$/)
  })

  it('omits the registered details while the Legal Notice is a draft', () => {
    const data = businessJsonLd({
      locale: 'en',
      company: null,
      legal: { ...legal, _status: 'draft' },
    })
    expect(data).not.toHaveProperty('legalName')
    expect(data).not.toHaveProperty('address')
    expect(data).not.toHaveProperty('vatID')
    expect(data).not.toHaveProperty('sameAs')
  })
})
