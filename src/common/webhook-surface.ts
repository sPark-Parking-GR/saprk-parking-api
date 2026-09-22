/**
 * Which handler processed a webhook delivery — the second half of WebhookEvent's replay gate.
 *
 * One provider account fans the SAME event id out to every endpoint subscribed to that event
 * type, and the driver and operator subscription endpoints are subscribed to an identical
 * four. Idempotency is therefore a property of (event id, handler) and not of the event id
 * alone: without the discriminator, whichever handler committed first claimed the id and the
 * other 200'd a delivery it had never applied.
 *
 * Declared once and shared rather than inlined per service, because these strings are the
 * live half of a database constraint: a typo would not fail anywhere, it would silently give
 * that handler a surface of its own and let every redelivery through as new.
 */
export const WEBHOOK_SURFACES = [
  'payments',
  'driver-subscription',
  'operator-subscription',
] as const

export type WebhookSurface = (typeof WEBHOOK_SURFACES)[number]

/**
 * The compound unique on WebhookEvent, by field name. The ONLY constraint whose violation
 * means "this handler already processed this event"; every other P2002 in a webhook
 * transaction is a real failure that must reach the provider as one.
 */
export const WEBHOOK_EVENT_KEY_FIELDS = ['providerEventId', 'surface'] as const

/**
 * True only for the replay gate. Handles both shapes Prisma reports for `meta.target`: the
 * field-name array on PostgreSQL, and the raw constraint name
 * (`WebhookEvent_providerEventId_surface_key`) some versions return. Every field must be
 * named, so a P2002 on a neighbouring single-column unique cannot pass as a replay.
 */
export function isWebhookReplayTarget(target: unknown): boolean {
  if (Array.isArray(target)) {
    return WEBHOOK_EVENT_KEY_FIELDS.every((field) => target.includes(field))
  }
  const name = String(target ?? '')
  return WEBHOOK_EVENT_KEY_FIELDS.every((field) => name.includes(field))
}
