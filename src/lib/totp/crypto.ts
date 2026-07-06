import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

import { getEncryptionKey } from './keys'

// AES-256-GCM: authenticated encryption (confidentiality + integrity) for
// the TOTP secret at rest in Postgres, per docs/TECHSPEC.md §7 ("TOTP
// secrets encrypted at rest"). GCM's auth tag means a tampered ciphertext
// fails to decrypt rather than silently producing garbage that might still
// parse as a plausible-looking secret.
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // 96-bit IV, the recommended size for GCM

/**
 * Encrypts a TOTP secret (base32 string) for storage in the `totpSecret`
 * field. Output format: `<iv>:<authTag>:<ciphertext>`, each base64.
 */
export function encryptTotpSecret(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  )
}

/**
 * Decrypts a value produced by encryptTotpSecret. Throws if the payload is
 * malformed or the auth tag doesn't verify (tampered/corrupted/wrong key).
 */
export function decryptTotpSecret(encrypted: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted TOTP secret (expected iv:authTag:ciphertext)')
  }

  const [ivB64, authTagB64, ciphertextB64] = parts
  const key = getEncryptionKey()
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
