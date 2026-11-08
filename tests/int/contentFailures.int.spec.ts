import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// What the public data layer (src/lib/content.ts) does when the database or
// the CMS fails, as opposed to when a query simply finds nothing.
//
// The distinction is the whole point. A page whose render THROWS during an ISR
// regeneration keeps serving its last good version; a page that renders an
// empty list or calls notFound() is cached as empty or as a 404. These
// fetchers used to swallow every error and return [] / null, so a Neon blip
// replaced good pages with empty ones and service pages with cached 404s, and a
// deploy against an unreachable database built a blank site and stayed green.
//
// No database is needed: Payload's getPayload is replaced with a stub, and the
// module is re-imported for every test because content.ts memoises its client.

const { getPayloadMock } = vi.hoisted(() => ({ getPayloadMock: vi.fn() }))

vi.mock('payload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('payload')>()
  return { ...actual, getPayload: getPayloadMock }
})

type ContentModule = typeof import('@/lib/content')

async function loadContent(): Promise<ContentModule> {
  vi.resetModules()
  return import('@/lib/content')
}

/** A stand-in Payload whose every read fails the way a dropped connection does. */
function brokenPayload(error: Error) {
  return {
    find: vi.fn().mockRejectedValue(error),
    findGlobal: vi.fn().mockRejectedValue(error),
  }
}

/** A stand-in Payload that answers every read with "nothing found". */
function emptyPayload() {
  return {
    find: vi.fn().mockResolvedValue({ docs: [] }),
    findGlobal: vi.fn().mockResolvedValue({}),
  }
}

/** Every public fetcher, called with valid arguments. */
function everyFetcher(c: ContentModule): [string, () => Promise<unknown>][] {
  return [
    ['getServices', () => c.getServices('en')],
    ['getServiceCardLimit', () => c.getServiceCardLimit()],
    ['getServiceBySlug', () => c.getServiceBySlug('roofing', 'en')],
    ['getPublishedServiceSlugs', () => c.getPublishedServiceSlugs()],
    ['getPublishedServicesForSitemap', () => c.getPublishedServicesForSitemap()],
    ['getProjects', () => c.getProjects('en')],
    ['getCareers', () => c.getCareers('en')],
    ['getCompanyInfo', () => c.getCompanyInfo('en')],
    ['getLegalInfo', () => c.getLegalInfo('en')],
  ]
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  getPayloadMock.mockReset()
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

/** The OPS_ALERT lines logged so far (the marker the production alarm counts). */
function opsAlerts(): string[] {
  return consoleError.mock.calls
    .map((args: unknown[]) => String(args[0]))
    .filter((line: string) => line.startsWith('OPS_ALERT'))
}

describe('content layer: a failed read throws instead of returning an empty result', () => {
  it('every fetcher throws ContentUnavailableError when a query fails, keeping the cause', async () => {
    const dbDown = new Error('Connection terminated unexpectedly')
    getPayloadMock.mockResolvedValue(brokenPayload(dbDown))
    const c = await loadContent()

    for (const [name, call] of everyFetcher(c)) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err, `${name} must throw, not return an empty result`).toBeInstanceOf(
        c.ContentUnavailableError,
      )
      expect((err as Error).cause, `${name} keeps the original error`).toBe(dbDown)
      expect((err as InstanceType<ContentModule['ContentUnavailableError']>).scope).toBe(
        `content.${name}`,
      )
    }
  })

  it('every fetcher throws when Payload itself cannot initialise (cold start during an outage)', async () => {
    getPayloadMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ep-example.neon.tech'))
    const c = await loadContent()

    for (const [name, call] of everyFetcher(c)) {
      await expect(call(), name).rejects.toBeInstanceOf(c.ContentUnavailableError)
    }
  })

  it('still reports each failure exactly once as an OPS_ALERT, so the alarm keeps firing', async () => {
    getPayloadMock.mockResolvedValue(brokenPayload(new Error('boom')))
    const c = await loadContent()

    await expect(c.getServiceBySlug('roofing', 'fr')).rejects.toThrow()
    const alerts = opsAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('content.getServiceBySlug')
    expect(alerts[0]).toContain('"slug":"roofing"')
    expect(alerts[0]).toContain('"locale":"fr"')
  })
})

describe('content layer: a query that finds nothing is still a normal empty result', () => {
  it('returns null / [] / 0 without throwing or alerting when the database answers "nothing"', async () => {
    getPayloadMock.mockResolvedValue(emptyPayload())
    const c = await loadContent()

    await expect(c.getServiceBySlug('does-not-exist', 'en')).resolves.toBeNull()
    await expect(c.getServices('en')).resolves.toEqual([])
    await expect(c.getProjects('en')).resolves.toEqual([])
    await expect(c.getCareers('en')).resolves.toEqual([])
    await expect(c.getPublishedServiceSlugs()).resolves.toEqual([])
    await expect(c.getPublishedServicesForSitemap()).resolves.toEqual([])
    await expect(c.getServiceCardLimit()).resolves.toBe(0)
    expect(opsAlerts()).toHaveLength(0)
  })
})

describe('content layer: a failed Payload init is not memoised', () => {
  it('retries the init on the next request, so the instance recovers when the database does', async () => {
    getPayloadMock
      .mockRejectedValueOnce(new Error('database not reachable'))
      .mockResolvedValue(emptyPayload())
    const c = await loadContent()

    await expect(c.getServices('en')).rejects.toBeInstanceOf(c.ContentUnavailableError)
    // Same module instance, so the same memoised client: the second call must
    // initialise again instead of replaying the first rejection forever.
    await expect(c.getServices('en')).resolves.toEqual([])
    expect(getPayloadMock).toHaveBeenCalledTimes(2)
  })

  it('reuses a successful init', async () => {
    getPayloadMock.mockResolvedValue(emptyPayload())
    const c = await loadContent()

    await c.getServices('en')
    await c.getProjects('en')
    expect(getPayloadMock).toHaveBeenCalledTimes(1)
  })
})

describe('route handlers answer 503, not 404 or 500, while content is unavailable', () => {
  function jsonRequest(url: string, body: unknown, ip: string): Request {
    return new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    })
  }

  it('/api/quote: an unreadable service is "try again", never "service not found"', async () => {
    getPayloadMock.mockResolvedValue(brokenPayload(new Error('boom')))
    vi.resetModules()
    const { POST } = await import('@/app/api/quote/route')

    const res = await POST(
      jsonRequest('http://localhost/api/quote', { slug: 'roofing', locale: 'en' }, '203.0.113.10'),
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'service_unavailable' })
    expect(res.headers.get('retry-after')).toBe('30')
  })

  it('/api/quote: a service that really does not exist is still a 404', async () => {
    getPayloadMock.mockResolvedValue(emptyPayload())
    vi.resetModules()
    const { POST } = await import('@/app/api/quote/route')

    const res = await POST(
      jsonRequest('http://localhost/api/quote', { slug: 'nope', locale: 'en' }, '203.0.113.11'),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'service_not_found' })
  })

  it('/api/contact: an unreadable company inbox gives the "contact us another way" 503', async () => {
    getPayloadMock.mockResolvedValue(brokenPayload(new Error('boom')))
    vi.resetModules()
    const { POST } = await import('@/app/api/contact/route')

    const res = await POST(
      jsonRequest(
        'http://localhost/api/contact',
        { name: 'Ada', email: 'ada@example.com', message: 'Hello', locale: 'en' },
        '203.0.113.12',
      ),
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'contact_unavailable' })
  })
})
