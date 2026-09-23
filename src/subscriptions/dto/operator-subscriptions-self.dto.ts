import { z } from 'zod'

/**
 * Both fields optional on purpose. An operator who wants a bigger plan and one who wants to
 * be called back are the same signal to the same human, and forcing a plan id would make the
 * second unexpressible — the request would then arrive naming a tier nobody actually chose.
 *
 * `.strict()` and a bounded message for the same reason every other write boundary here has
 * them: the message is free text an operator authored, it is stored in an audit row and
 * mailed onwards, and an unbounded one is a body-size problem in both places.
 */
export const requestOperatorUpgradeSchema = z
  .object({
    requestedPlanId: z.string().trim().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()

export type RequestOperatorUpgradeDto = z.infer<typeof requestOperatorUpgradeSchema>

/**
 * `.strict()` is the security control here, not a style choice: successUrl and cancelUrl are
 * built server-side from WEB_APP_URL, and a body that could smuggle either in would turn
 * checkout into an open redirect an operator is sent to straight after paying. There is no
 * operatorId field for the same reason there is none on any route of this controller — the
 * tenant is derived from the caller's own memberships and is not theirs to name.
 */
export const startOperatorCheckoutSchema = z.object({ planId: z.string().trim().min(1) }).strict()

export type StartOperatorCheckoutDto = z.infer<typeof startOperatorCheckoutSchema>
