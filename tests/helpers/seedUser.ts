import { getPayload } from 'payload'
import config from '../../src/payload.config.js'

import { encryptTotpSecret } from '../../src/lib/totp/crypto.js'
import { generateTotpSecret } from '../../src/lib/totp/otp.js'

export const testUser = {
  email: 'dev@payloadcms.com',
  password: 'test',
}

// Fixed (not randomly regenerated per run) so login.ts can compute a live
// code for it without the seed and login helpers needing to coordinate a
// value at runtime. Test-only — never used outside this fixture.
export const testUserTotpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

/**
 * Seeds a test user for e2e admin tests, pre-provisioned with TOTP already
 * enabled. 2FA is mandatory for every admin login (FUNCTIONALITY.md §5.1,
 * enforced by src/access/requireTotpVerified.ts) — most e2e specs are
 * exercising unrelated admin functionality and shouldn't also have to walk
 * through the enrollment UI just to reach the dashboard. The dedicated
 * enrollment/verification flow itself is covered separately by
 * tests/e2e/totp.e2e.spec.ts, which seeds its own user WITHOUT TOTP
 * pre-enabled so it can exercise that flow from a clean state.
 */
export async function seedTestUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'users',
    where: {
      email: {
        equals: testUser.email,
      },
    },
  })

  await payload.create({
    collection: 'users',
    data: {
      ...testUser,
      totpEnabled: true,
      totpSecret: encryptTotpSecret(testUserTotpSecret),
    },
  })
}

/**
 * Seeds a fresh test user with NO TOTP configured yet, for tests that
 * specifically exercise the first-time enrollment flow.
 */
export async function seedUnenrolledTestUser(email: string, password: string): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'users',
    where: { email: { equals: email } },
  })

  await payload.create({
    collection: 'users',
    data: { email, password },
  })
}

/**
 * Seeds a user that is ALREADY enrolled in 2FA, with a known, fixed secret and
 * no previously-consumed TOTP time-step (totpLastTimeStep is left unset) —
 * modelling an admin who enrolled at some earlier point and is now starting a
 * fresh session. Used by the "new session" e2e test so its login code can
 * never collide with a just-consumed enrollment time-step: otplib's replay
 * protection rejects a code whose time-step was already used (see
 * src/lib/totp/otp.ts / requireTotpVerified), which otherwise makes that test
 * flaky depending on where the 30-second TOTP window boundary happens to fall.
 */
export async function seedEnrolledTestUser(
  email: string,
  password: string,
  secret: string,
): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'users',
    where: { email: { equals: email } },
  })

  await payload.create({
    collection: 'users',
    data: {
      email,
      password,
      totpEnabled: true,
      totpSecret: encryptTotpSecret(secret),
    },
  })
}

/**
 * Cleans up test user after tests
 */
export async function cleanupTestUser(): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'users',
    where: {
      email: {
        equals: testUser.email,
      },
    },
  })
}

export async function cleanupUserByEmail(email: string): Promise<void> {
  const payload = await getPayload({ config })

  await payload.delete({
    collection: 'users',
    where: { email: { equals: email } },
  })
}

// Re-exported so test files don't need their own import of otplib just to
// generate a code for assertions/manual flows.
export { generateTotpSecret }
