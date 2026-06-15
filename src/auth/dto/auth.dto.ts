import { z } from 'zod'

export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(80).optional(),
  role: z.enum(['user', 'operator_admin']).optional(),
})

export type SignUpDto = z.infer<typeof signUpSchema>

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export type SignInDto = z.infer<typeof signInSchema>

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

export type RefreshDto = z.infer<typeof refreshSchema>
