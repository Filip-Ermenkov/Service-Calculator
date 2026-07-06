import { hkdfSync } from 'crypto'

/**
 * Single source of key material for everything TOTP-related that needs a
 * secret: encrypting `totpSecret` at rest, and signing the short-lived
 * "second factor verified" step-up cookie (see stepUpToken.ts).
 *
 * Deliberately a *separate* env var from PAYLOAD_SECRET (which Payload uses
 * for its own JWT signing) rather than reusing it — key separation so a
 * compromise or rotation of one doesn't automatically implicate the other,
 * and so this module's purpose is self-documenting from its own env var
 * name. Generate with the same `openssl rand -base64 32` convention already
 * used for PAYLOAD_SECRET (see .env.example).
 *
 * HKDF (RFC 5869) derives two independent subkeys from the one root secret
 * — one for AES-256-GCM encryption, one for HMAC signing — rather than
 * using the same raw key material for two different cryptographic
 * purposes, which is the safer, current-best-practice pattern (using one
 * key for two algorithms risks subtle cross-purpose weaknesses even when
 * neither algorithm is broken on its own).
 */

function getRootKey(): Buffer {
  const raw = process.env.TOTP_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it ' +
        'in your environment (see .env.example). Required for TOTP secret encryption and the ' +
        '2FA step-up cookie signature.',
    )
  }

  const buf = Buffer.from(raw, 'base64')
  if (buf.length < 32) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY must decode (as base64) to at least 32 bytes. Generate one with ' +
        '`openssl rand -base64 32`.',
    )
  }

  return buf
}

function derive(info: string, length: number): Buffer {
  const rootKey = getRootKey()
  // Fixed, empty salt is fine here: the root key itself is high-entropy
  // random material (not a low-entropy password), which is the case HKDF's
  // salt-optional mode is designed for.
  const derived = hkdfSync('sha256', rootKey, Buffer.alloc(0), info, length)
  return Buffer.from(derived)
}

export function getEncryptionKey(): Buffer {
  return derive('bulbau-totp-secret-encryption-v1', 32)
}

export function getSigningKey(): Buffer {
  return derive('bulbau-totp-stepup-cookie-signing-v1', 32)
}
