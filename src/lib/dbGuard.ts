/**
 * Refuse to run Drizzle `push` against anything but a LOCAL database.
 *
 * Why: with NODE_ENV unset (`npm run dev`, `npm run test:int`, `payload run …`)
 * Payload's postgres adapter runs in `push` mode — on boot it syncs the schema
 * to the config AND writes a `payload_migrations` marker row (`dev`, batch -1).
 * Pointed at a deployed stage's Neon branch, one accidental `npm run dev` does
 * exactly that to STAGING: it happened three times on 2026-09-13/14 (each time
 * needing a hand repair before the fail-closed CI migrate step would pass, see
 * scripts/verify-migrations.mjs). A comment in `.env` did not prevent it; a
 * process that refuses to start does.
 *
 * Deployed stages and the CI migrate steps run with NODE_ENV=production (push
 * OFF), so this never fires there. CI's `verify` job and local Docker use
 * `localhost`. Anything else has to opt in explicitly.
 *
 * Pure (no Payload import) so it is unit-testable; wired in src/payload.config.ts.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal', 'postgres', 'db'])

/** True for an empty URL (CI sets it explicitly) or one whose host is a local address. */
export function isLocalDatabaseUrl(url: string): boolean {
  if (!url) return true
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    // Not a parseable URL — let the adapter produce its own connection error.
    return true
  }
  return LOCAL_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')
}

export const ALLOW_REMOTE_PUSH_ENV = 'ALLOW_REMOTE_DB_PUSH'

/**
 * The message to fail with, or null when starting is safe. `push` is the
 * adapter's schema-push flag; `override` is the escape hatch's env value.
 */
export function remotePushProblem(params: {
  databaseUrl: string
  push: boolean
  override?: string
}): string | null {
  if (!params.push || isLocalDatabaseUrl(params.databaseUrl)) return null
  if (params.override === 'true') return null
  let host = params.databaseUrl
  try {
    host = new URL(params.databaseUrl).hostname
  } catch {
    // keep the raw value
  }
  return (
    `Refusing to start: NODE_ENV is not "production", so Payload would PUSH schema ` +
    `changes (and write the dev-migration marker) straight into the database at "${host}" — ` +
    `which is not a local database. Local dev and tests must use the Docker Postgres ` +
    `(postgresql://…@localhost:5431/bulbau): fix DATABASE_URL in .env and restart. ` +
    `To run a deployed stage's migrations use ` +
    `"npx cross-env NODE_ENV=production DATABASE_URL=<direct url> npm run migrate", and ` +
    `"npx cross-env DATABASE_URL=<direct url> npm run migrate:verify -- --pre" to check it. ` +
    `(${ALLOW_REMOTE_PUSH_ENV}=true overrides this guard — only if you really mean it.)`
  )
}
