import type { CollectionConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'

import {
  totpDisableEndpoint,
  totpEnableEndpoint,
  totpSetupEndpoint,
  totpStatusEndpoint,
  totpVerifyEndpoint,
} from './Users.endpoints'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
  },
  auth: {
    // Payload's own built-in lockout for the PASSWORD step (first factor).
    // This is separate from, and in addition to, the TOTP-specific rate
    // limiting in src/lib/totp/rateLimit.ts, which covers the second
    // factor. Values match docs/FUNCTIONALITY.md §5.1 ("temporarily locked
    // and the admin must wait before trying again") without pinning an
    // exact number there — 5 attempts / 10 minutes is a conventional,
    // moderate default for a single-admin site (strict enough to blunt
    // brute-forcing, loose enough that a few genuine typos don't lock out
    // the one person who can use this panel).
    maxLoginAttempts: 5,
    lockTime: 10 * 60 * 1000,
  },
  endpoints: [
    totpSetupEndpoint,
    totpEnableEndpoint,
    totpVerifyEndpoint,
    totpDisableEndpoint,
    totpStatusEndpoint,
  ],
  access: {
    // Payload's own default (`Boolean(user)`, i.e. any logged-in user) is
    // made explicit here specifically so it can be wrapped: `() => true`
    // delegates that same "must be logged in" decision to
    // requireTotpVerified, which additionally requires the TOTP step to be
    // complete before any of it is reached. See
    // src/access/requireTotpVerified.ts for why this — not the admin UI's
    // own redirects — is the real security boundary.
    read: requireTotpVerified(() => true),
    create: requireTotpVerified(() => true),
    update: requireTotpVerified(() => true),
    delete: requireTotpVerified(() => true),
    // `unlock` is the FIFTH access operation an auth-enabled collection has, and
    // it was the one this list previously missed — so it silently fell back to
    // Payload's `defaultAccess` (`Boolean(user)`), i.e. NO TOTP step-up.
    //
    // Why that mattered: `POST /api/users/unlock` clears the login lockout that
    // `auth.maxLoginAttempts`/`lockTime` above impose after 5 failed password
    // attempts. Under the default access rule, a session that had passed the
    // PASSWORD step but not the mandatory second factor could reset that
    // counter — letting the first-factor brute-force defence be cleared by
    // something less than a fully authenticated admin. Wrapping it here makes
    // the whole collection uniform: every operation requires a completed TOTP
    // step-up, no exceptions.
    //
    // Found while triaging GHSA-jg8r-5jh2-v2xj (Payload <= 3.88.0, "default
    // account-unlock access allows authenticated users to reset other accounts'
    // lockouts").
    //
    // READ THIS BEFORE REMOVING THE LINE: bumping Payload does NOT fix it. The
    // advisory's own page lists "Patched versions: None"; npm reports a fix
    // simply because 3.89.0 falls outside the `<=3.88.0` affected range, and
    // 3.89.0's release notes contain no such fix. Verified against the installed
    // 3.89.0 source: `collections/config/defaults.js` still sets
    // `unlock: defaultAccess`, and `auth/operations/unlock.js` still gates only
    // on `collectionConfig.access.unlock`. So the upgrade silences the audit
    // line while leaving the behaviour unchanged — THIS rule is the actual fix.
    // tests/int/rest.int.spec.ts proves it: delete this line and the
    // password-only session gets 200 back.
    unlock: requireTotpVerified(() => true),
  },
  fields: [
    // Email added by default
    {
      name: 'totpSecret',
      type: 'text',
      // Encrypted (AES-256-GCM, src/lib/totp/crypto.ts) before it ever
      // reaches the database. Hidden from the admin UI and never
      // API-readable — the only code that reads/writes it is
      // Users.endpoints.ts, using the Local API with `overrideAccess:
      // true`. There is deliberately no legitimate path for this field's
      // value to leave the server, encrypted or not.
      admin: { hidden: true },
      access: {
        read: () => false,
        update: () => false,
      },
    },
    {
      name: 'totpEnabled',
      type: 'checkbox',
      defaultValue: false,
      // The entire enrollment/verification lifecycle is handled by the
      // dedicated /admin/totp-setup and /admin/totp-verify views (see
      // src/app/(payload)/admin/...), not the default field editor —
      // showing it there too would just be a second, confusing, editable
      // control for something that must only ever change via the
      // TOTP-verified endpoints above.
      admin: { hidden: true },
      access: {
        read: () => false,
        update: () => false,
      },
    },
    {
      name: 'totpLastTimeStep',
      type: 'number',
      // Replay protection bookkeeping (otplib's `afterTimeStep` pattern —
      // see src/lib/totp/otp.ts) — the last TOTP time-step this account
      // successfully verified, so the same 6-digit code can't be reused
      // twice even within its normal validity window.
      admin: { hidden: true },
      access: {
        read: () => false,
        update: () => false,
      },
    },
  ],
  versions: false,
}
