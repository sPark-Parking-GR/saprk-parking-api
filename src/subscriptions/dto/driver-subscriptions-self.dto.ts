import { z } from 'zod'

/**
 * `.strict()` is the security control here, not a style choice: successUrl and cancelUrl are
 * built server-side from fixed constants, and a body that could smuggle either in would turn
 * checkout into an open redirect a rider is sent to straight after paying.
 */
export const startDriverCheckoutSchema = z.object({ planId: z.string().trim().min(1) }).strict()

export type StartDriverCheckoutDto = z.infer<typeof startDriverCheckoutSchema>
