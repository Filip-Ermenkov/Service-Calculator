/**
 * Services management write API — the write side of the custom Services admin
 * screen (ServicesView / ServicesManager). The screen itself is a read-only
 * server component; every mutation it offers goes through this one route:
 *
 *   • reorder  — persist a new drag order (fractional `_order` keys). This order
 *                is what the public Home page uses for its service cards
 *                (FUNCTIONALITY.md §3.1 / §5.3).
 *   • delete   — delete a single service.
 *   • setLimit — save the Home-page "number of cards" setting (home-settings global).
 *
 * SECURITY: unlocalized `/api/*` route (src/proxy.ts does NOT gate it — the
 * matcher excludes /api), so it authenticates itself exactly like
 * /api/admin/translations: a valid Payload session AND a valid TOTP step-up
 * cookie (mirroring src/access/requireTotpVerified.ts). Without both it returns
 * 401/403 and never touches content.
 */

import { headers as getHeaders } from 'next/headers'
import { NextResponse } from 'next/server'
import { generateNKeysBetween } from 'payload/shared'

import { getPayloadClient } from '@/lib/content'
import { isStepUpVerified } from '@/lib/totp/requestHelpers'

export const dynamic = 'force-dynamic'

interface WriteBody {
  action?: 'reorder' | 'delete' | 'setLimit'
  ids?: (string | number)[]
  id?: string | number
  limit?: number
}

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status })
}

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    return bad(413, 'payload_too_large')
  }

  let body: WriteBody
  try {
    body = (await request.json()) as WriteBody
  } catch {
    return bad(400, 'invalid_json')
  }

  const { action } = body
  if (action !== 'reorder' && action !== 'delete' && action !== 'setLimit') {
    return bad(400, 'invalid_action')
  }

  // ── AuthN/AuthZ: valid session + valid TOTP step-up cookie ──
  const payload = await getPayloadClient()
  const headers = await getHeaders()
  const { user } = await payload.auth({ headers })
  if (!user) return bad(401, 'unauthenticated')
  if (!isStepUpVerified(headers, String(user.id))) return bad(403, 'step_up_required')

  try {
    if (action === 'reorder') {
      const ids = Array.isArray(body.ids) ? body.ids : null
      if (!ids || ids.length === 0) return bad(400, 'missing_ids')
      if (ids.length > 500) return bad(413, 'too_many_ids')

      // Fresh, evenly-spaced fractional keys for the whole list in the new order.
      const keys = generateNKeysBetween(null, null, ids.length)

      // Preserve each doc's publish state exactly — reordering must never flip a
      // draft to published or vice-versa (mirrors the translations route).
      const existing = await payload.find({
        collection: 'services',
        depth: 0,
        limit: 1000,
        pagination: false,
        overrideAccess: true,
        draft: true,
      })
      const statusById = new Map<string, string | undefined>()
      for (const d of existing.docs) {
        statusById.set(String(d.id), d._status ?? undefined)
      }

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        const status = statusById.get(String(id))
        const data: Record<string, unknown> = { _order: keys[i] }
        if (status) data._status = status
        await (payload.update as CallableFunction)({
          collection: 'services',
          id,
          data,
          draft: status === 'draft',
          overrideAccess: true,
          context: { skipAutoTranslate: true },
        })
      }
      return NextResponse.json({ ok: true })
    }

    if (action === 'delete') {
      const id = body.id
      if (id === undefined || id === null || id === '') return bad(400, 'missing_id')
      await payload.delete({ collection: 'services', id, overrideAccess: true })
      return NextResponse.json({ ok: true })
    }

    // action === 'setLimit'
    const limit = body.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 1000) {
      return bad(400, 'invalid_limit')
    }
    await (payload.updateGlobal as CallableFunction)({
      slug: 'home-settings',
      data: { serviceCardLimit: limit },
      overrideAccess: true,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    payload.logger?.error?.(`[services] ${action} failed: ${(err as Error)?.message ?? err}`)
    return bad(500, 'write_failed')
  }
}
