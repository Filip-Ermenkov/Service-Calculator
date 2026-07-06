import {
  STEP_UP_COOKIE_MAX_AGE_SECONDS,
  STEP_UP_COOKIE_NAME,
  signStepUpToken,
  verifyStepUpToken,
} from './stepUpToken'

/** Parses the raw `Cookie` request header into a name -> value map. */
function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {}
  const out: Record<string, string> = {}
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

/** True in any environment where cookies should NOT get the `Secure` flag (local HTTP dev). */
function isInsecureDevEnvironment(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
}

export function getStepUpCookieFromHeaders(headers: Headers): string | undefined {
  const cookies = parseCookies(headers.get('cookie'))
  return cookies[STEP_UP_COOKIE_NAME]
}

/** Checks whether the incoming request already carries a valid step-up cookie for `userId`. */
export function isStepUpVerified(headers: Headers, userId: string): boolean {
  const token = getStepUpCookieFromHeaders(headers)
  return verifyStepUpToken(token, userId)
}

/**
 * Same check, but from Payload's already-parsed `InitPageResult.cookies` map
 * (available to admin Root View Server Components) instead of raw headers —
 * avoids re-parsing the Cookie header when it's already been done for us.
 */
export function isStepUpVerifiedFromCookieMap(
  cookies: Map<string, string>,
  userId: string,
): boolean {
  return verifyStepUpToken(cookies.get(STEP_UP_COOKIE_NAME), userId)
}

/** Builds a `Set-Cookie` header value that grants step-up (2FA-verified) status. */
export function buildStepUpSetCookie(userId: string): string {
  const token = signStepUpToken(userId)
  const secure = isInsecureDevEnvironment() ? '' : '; Secure'
  return `${STEP_UP_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STEP_UP_COOKIE_MAX_AGE_SECONDS}${secure}`
}

/** Builds a `Set-Cookie` header value that clears the step-up cookie (used on 2FA disable/logout). */
export function buildStepUpClearCookie(): string {
  const secure = isInsecureDevEnvironment() ? '' : '; Secure'
  return `${STEP_UP_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}
