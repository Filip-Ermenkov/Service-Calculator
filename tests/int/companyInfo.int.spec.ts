import { describe, expect, it } from 'vitest'

import { validateHttpsUrl } from '@/globals/CompanyInfo'

// `CompanyInfo.facebookUrl` / `instagramUrl` go straight into `<a href>` on every
// public page, so the validator is the only thing standing between an admin typo
// (or a hostile value from a compromised admin session) and a broken/dangerous
// link. Payload's own text validation runs first; these pin the URL rule.
// The same minimal Payload `validate` options the Services field tests use.
const options = { data: {}, siblingData: {}, req: { payload: { config: {} }, t: (key: string) => key } } as never

const run = (value: unknown) => validateHttpsUrl(value as string, options)

describe('CompanyInfo — validateHttpsUrl (social profile links)', () => {
  it('accepts an absolute https:// address, and blank (the field is optional)', () => {
    expect(run('https://www.facebook.com/bulbau')).toBe(true)
    expect(run('https://instagram.com/bulbau.lu/')).toBe(true)
    expect(run('  https://www.facebook.com/bulbau  ')).toBe(true)
    expect(run('')).toBe(true)
    expect(run(undefined)).toBe(true)
    expect(run(null)).toBe(true)
  })

  it('rejects a bare domain (it would render as a same-site relative link)', () => {
    expect(run('facebook.com/bulbau')).toMatch(/starting with https:\/\//)
    expect(run('www.instagram.com/bulbau')).toMatch(/https:\/\//)
  })

  it('rejects any scheme other than https — http, mailto, and above all javascript:', () => {
    expect(run('http://www.facebook.com/bulbau')).toMatch(/must start with https:\/\//)
    expect(run('javascript:alert(1)')).toMatch(/https:\/\//)
    expect(run('mailto:someone@example.com')).toMatch(/https:\/\//)
  })

  it('rejects an https URL with no real host', () => {
    expect(run('https://localhost/x')).toMatch(/full address/)
  })
})
