import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __setCdnImplsForTests,
  invalidateCdn,
  isCdnInvalidationConfigured,
} from '@/lib/cdn/invalidate'

// Pure coverage for the on-demand CloudFront invalidation module
// (src/lib/cdn/invalidate.ts). No AWS / network: the SSM read and the
// CloudFront CreateInvalidation call are exercised through the test seams
// (__setCdnImplsForTests). The real end-to-end purge (admin edit → edge fresh)
// is covered by the manual/e2e guide, since it needs a deployed distribution.

const PARAM = '/bulbau-lu/test/web-cdn-distribution-id'

// Signature of the injectable CloudFront "send" seam — typed so `vi.fn<SendFn>`
// records real argument tuples (an untyped vi.fn infers `[]`, making
// `.mock.calls[0]` an empty tuple and `toHaveBeenCalledWith(a, b, c)` a type error).
type SendFn = (
  distributionId: string,
  paths: string[],
  signal: AbortSignal,
) => Promise<void>

describe('cdn/invalidate.ts — on-demand CloudFront invalidation', () => {
  const OLD = { ...process.env }

  beforeEach(() => {
    process.env = { ...OLD }
  })
  afterEach(() => {
    __setCdnImplsForTests(null)
    process.env = { ...OLD }
    vi.restoreAllMocks()
  })

  describe('isCdnInvalidationConfigured()', () => {
    it('is false when the parameter env var is unset', () => {
      delete process.env.CDN_DISTRIBUTION_ID_PARAM
      expect(isCdnInvalidationConfigured()).toBe(false)
    })
    it('is true when the parameter env var is set', () => {
      process.env.CDN_DISTRIBUTION_ID_PARAM = PARAM
      expect(isCdnInvalidationConfigured()).toBe(true)
    })
  })

  it('is a no-op when unconfigured (never resolves an id or sends)', async () => {
    delete process.env.CDN_DISTRIBUTION_ID_PARAM
    const resolve = vi.fn(async () => 'DIST123')
    const send = vi.fn<SendFn>(async () => {})
    __setCdnImplsForTests({ resolve, send })

    await expect(invalidateCdn()).resolves.toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('invalidates the resolved distribution with the /* wildcard by default', async () => {
    process.env.CDN_DISTRIBUTION_ID_PARAM = PARAM
    const send = vi.fn<SendFn>(async () => {})
    __setCdnImplsForTests({ resolve: async () => 'DIST123', send })

    await invalidateCdn()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('DIST123', ['/*'], expect.any(AbortSignal))
  })

  it('passes through explicit paths', async () => {
    process.env.CDN_DISTRIBUTION_ID_PARAM = PARAM
    const send = vi.fn<SendFn>(async () => {})
    __setCdnImplsForTests({ resolve: async () => 'DIST123', send })

    await invalidateCdn(['/en', '/fr'])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      'DIST123',
      ['/en', '/fr'],
      expect.any(AbortSignal),
    )
  })

  it('skips the send (but does not throw) when the id cannot be resolved', async () => {
    process.env.CDN_DISTRIBUTION_ID_PARAM = PARAM
    const send = vi.fn<SendFn>(async () => {})
    __setCdnImplsForTests({ resolve: async () => null, send })

    await expect(invalidateCdn()).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('never throws when the CloudFront call rejects (a save must not roll back)', async () => {
    process.env.CDN_DISTRIBUTION_ID_PARAM = PARAM
    __setCdnImplsForTests({
      resolve: async () => 'DIST123',
      send: async () => {
        throw new Error('AccessDenied')
      },
    })

    await expect(invalidateCdn()).resolves.toBeUndefined()
  })

  it('never throws when resolving the id rejects', async () => {
    process.env.CDN_DISTRIBUTION_ID_PARAM = PARAM
    const send = vi.fn<SendFn>(async () => {})
    __setCdnImplsForTests({
      resolve: async () => {
        throw new Error('SSM unavailable')
      },
      send,
    })

    await expect(invalidateCdn()).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it('resolves the distribution id at most once across calls (cached per instance)', async () => {
    process.env.CDN_DISTRIBUTION_ID_PARAM = PARAM
    const resolve = vi.fn(async () => 'DIST123')
    const send = vi.fn<SendFn>(async () => {})
    __setCdnImplsForTests({ resolve, send })

    await invalidateCdn()
    await invalidateCdn()
    await invalidateCdn()

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('does not cache a failed resolution (retries on the next change)', async () => {
    process.env.CDN_DISTRIBUTION_ID_PARAM = PARAM
    let attempt = 0
    const resolve = vi.fn(async () => {
      attempt += 1
      return attempt === 1 ? null : 'DIST123'
    })
    const send = vi.fn<SendFn>(async () => {})
    __setCdnImplsForTests({ resolve, send })

    await invalidateCdn() // first: resolves null → no send
    await invalidateCdn() // second: resolves the id → sends

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('DIST123', ['/*'], expect.any(AbortSignal))
  })
})
