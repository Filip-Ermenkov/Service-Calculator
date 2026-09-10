/**
 * Operational alert logging — the app→infrastructure contract that turns this
 * codebase's "resilient degradation" catch blocks into an actual alarm signal
 * (AWS Well-Architected — Operational Excellence / Reliability).
 *
 * ── The gap this closes (worth a fresh session understanding) ─────────────────
 * Several subsystems here deliberately NEVER throw: `src/lib/content.ts` returns
 * an empty list when Neon is unreachable, `src/lib/revalidate.ts` and
 * `src/lib/cdn/invalidate.ts` swallow refresh failures, `src/lib/email/ses.ts`
 * returns `{ ok: false }` instead of raising. That is the right behaviour for a
 * visitor — a transient content-layer fault degrades one section instead of
 * crashing the page — but it produced a genuine blind spot:
 *
 *   • A DB outage renders the whole site as EMPTY pages with HTTP **200**.
 *   • OpenNext/Next returns a 500 *response* without the Lambda handler
 *     throwing, so the CloudWatch `AWS/Lambda` **Errors** metric stays at zero.
 *
 * i.e. every alarm the account had could sit green while the public site served
 * blank pages or dropped contact-form leads. Nothing anywhere was watching.
 *
 * ── The mechanism ────────────────────────────────────────────────────────────
 * Each of those catch blocks now also calls `logOpsEvent()`, which writes ONE
 * single-line, greppable marker to stderr:
 *
 *   OPS_ALERT {"scope":"content.getServices","severity":"error","message":"…"}
 *
 * `sst.config.ts` puts a CloudWatch Logs **metric filter** on the Web function's
 * log group matching the literal `OPS_ALERT`, publishing to a custom metric that
 * a CloudWatch alarm watches (→ the `bulbau-lu-ops-alerts` SNS topic → email).
 * Nothing is sent from the request path itself: no extra SDK call, no added
 * latency, no IAM, no cost beyond the custom metric.
 *
 * Self-healing degradations (a missed CDN purge that the ISR window will fix on
 * its own) use a SEPARATE `OPS_WARN` marker, so they are logged and greppable
 * but do not page anyone — see `OPS_WARN_MARKER`.
 *
 * ── Invariants this module MUST keep (the filter depends on them) ─────────────
 *  1. **Exactly one line per event.** A CloudWatch log event is delimited by
 *     newlines; a multi-line payload would both split the event and match the
 *     filter more than once. Every embedded newline/carriage return is stripped.
 *  2. **The marker is the first token**, so the filter pattern stays a cheap,
 *     unambiguous literal (`"OPS_ALERT"`) rather than a fragile field pattern.
 *  3. **It never throws.** It is called from inside catch blocks — a failure
 *     here must never turn a degraded read into a crashed page.
 *  4. **No stack traces, no user data.** Only a scope, a bounded message, and
 *     optional short scalar context. Log volume stays trivial and nothing
 *     personal (a visitor's email, a message body) can reach CloudWatch.
 */

import { getDeployStage } from './stage'

/**
 * The literal token an ALERTING line starts with. `sst.config.ts`'s CloudWatch
 * metric filter matches this exact string, so it is a cross-tool contract:
 * change it here and change the filter pattern in the same commit.
 */
export const OPS_ALERT_MARKER = 'OPS_ALERT'

/**
 * The marker for a degraded-but-self-healing event. Deliberately a DIFFERENT
 * token, not a `severity` field the filter would have to parse: CloudWatch's
 * unstructured filter syntax makes "match the marker AND a nested JSON field"
 * an escaping minefield, whereas two distinct literals are trivially correct.
 * Warnings stay greppable in the logs without paging anyone at 3am.
 */
export const OPS_WARN_MARKER = 'OPS_WARN'

/** Hard cap on the logged message so one pathological error can't flood logs. */
const MAX_MESSAGE_LENGTH = 300

/**
 * `error` = user-visible degradation that should page someone (an empty page, a
 * lost lead). `warn` = degraded but self-healing (a stale edge cache that the
 * time-based `revalidate` window will fix on its own).
 */
export type OpsSeverity = 'error' | 'warn'

/** Short, non-personal context values. Objects/arrays are deliberately not accepted. */
export type OpsContext = Record<string, string | number | boolean | null | undefined>

/** Collapse to a single line and bound the length. */
function normalizeMessage(value: unknown): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : value === undefined || value === null
          ? ''
          : String(value)

  const oneLine = raw.replace(/[\r\n\t]+/g, ' ').trim()
  return oneLine.length > MAX_MESSAGE_LENGTH
    ? `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : oneLine
}

/**
 * Builds the single log line. Exported so the unit tests can assert the exact
 * shape the CloudWatch metric filter depends on, without capturing stderr.
 */
export function formatOpsEvent(
  scope: string,
  error: unknown,
  severity: OpsSeverity = 'error',
  context?: OpsContext,
): string {
  const payload: Record<string, unknown> = {
    scope,
    severity,
    message: normalizeMessage(error),
    stage: getDeployStage(),
  }

  if (context) {
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) continue
      payload[key] = typeof value === 'string' ? normalizeMessage(value) : value
    }
  }

  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    // A context value that can't be serialized must not lose the alert itself.
    serialized = JSON.stringify({ scope, severity, message: 'unserializable' })
  }

  // Defence-in-depth for invariant 1: JSON.stringify escapes newlines inside
  // strings, but a key could in principle carry one.
  const marker = severity === 'warn' ? OPS_WARN_MARKER : OPS_ALERT_MARKER
  return `${marker} ${serialized.replace(/[\r\n]+/g, ' ')}`
}

/**
 * Emit one operational alert. Safe to call from any catch block.
 *
 * @param scope   Stable dotted identifier of the failing operation, e.g.
 *                `content.getServices`. Used to triage from the alarm email —
 *                keep it stable, it is effectively part of the runbook.
 * @param error   The caught value (an `Error`, a string, anything).
 * @param severity `error` (default) emits `OPS_ALERT` and pages; `warn` emits
 *                 `OPS_WARN`, which the metric filter deliberately ignores.
 * @param context Optional short scalars (a slug, a locale) — never user data.
 */
export function logOpsEvent(
  scope: string,
  error: unknown,
  severity: OpsSeverity = 'error',
  context?: OpsContext,
): void {
  try {
    // stderr for both severities: CloudWatch does not distinguish streams, and
    // keeping one destination keeps the metric filter a single pattern.
    console.error(formatOpsEvent(scope, error, severity, context))
  } catch {
    // Invariant 3: swallowing is the whole point — this is called from inside a
    // catch block that is itself protecting a page render.
  }
}
