/**
 * Home-page card-count setting — the one write the Services list still needs
 * outside Payload's own REST API.
 *
 *   • setLimit — save how many service cards the public Home page shows
 *                (the `home-settings` global; 0 = show all). Used by the
 *                HomeCardLimitForm rendered under the Services list.
 *
 * Until 2026-09-14 this route also carried `reorder` and `delete` for a bespoke
 * Services table. That table is gone — the Services list is Payload's native
 * list view, whose drag ordering goes through Payload's own `/api/reorder`
 * endpoint (gated by the collection's `update` access, i.e. the TOTP step-up)
 * and whose deletes/bulk actions go through the collection's REST endpoints.
 * Fewer bespoke write paths, same security boundary.
 *
 * SECURITY: unlocalized `/api/*` route (src/proxy.ts does NOT gate it — the
 * matcher excludes /api), so it authenticates itself exactly like
 * /api/admin/translations: a valid Payload session AND a valid TOTP step-up
 * cookie (mirroring src/access/requireTotpVerified.ts). Without both it returns
 * 401/403 and never touches content.
 */

import { headers as getHeaders } from 'next/headers'
import { NextResponse } from 'next/server'

import { getPayloadClient } from '@/lib/content'
import { isStepUpVerified } from '@/lib/totp/requestHelpers'

export const dynamic = 'force-dynamic'

interface WriteBody {
  action?: 'setLimit'
  limit?: number
}

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status })
}

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > 4 * 1024) {
    return bad(413, 'payload_too_large')
  }

  let body: WriteBody
  try {
    body = (await request.json()) as WriteBody
  } catch {
    return bad(400, 'invalid_json')
  }

  if (body.action !== 'setLimit') return bad(400, 'invalid_action')
  const limit = body.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 1000) {
    return bad(400, 'invalid_limit')
  }

  // ── AuthN/AuthZ: valid session + valid TOTP step-up cookie ──
  const payload = await getPayloadClient()
  const headers = await getHeaders()
  const { user } = await payload.auth({ headers })
  if (!user) return bad(401, 'unauthenticated')
  if (!isStepUpVerified(headers, String(user.id))) return bad(403, 'step_up_required')

  try {
    // The global's afterChange revalidate hook fires, so the Home page refreshes.
    await (payload.updateGlobal as CallableFunction)({
      slug: 'home-settings',
      data: { serviceCardLimit: limit },
      overrideAccess: true,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    payload.logger?.error?.(`[services] setLimit failed: ${(err as Error)?.message ?? err}`)
    return bad(500, 'write_failed')
  }
}
