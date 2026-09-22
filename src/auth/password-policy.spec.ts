import { PASSWORD_MAX, PASSWORD_MIN } from '@spark/types'
import { resetPasswordSchema, signInSchema, signUpSchema } from './dto/auth.dto'
import { acceptInviteSchema } from '../invite/dto/invite.dto'
import { acceptAdminInviteSchema } from '../identity/dto/admin-invite.dto'
import { registerOperatorSchema } from '../operators/dto/operator-registration.dto'

/**
 * These five schemas each used to carry their own copy of the bounds, and two of them had
 * drifted to a 200 ceiling. That is not cosmetic: a password created above the reset
 * ceiling can never be changed, because the endpoint that would change it refuses the
 * length the account was created with. This suite is what stops them drifting again.
 */
describe('password policy', () => {
  const setters = {
    'sign-up': (password: string) => signUpSchema.safeParse({ email: 'a@b.com', password }),
    'password reset': (password: string) => resetPasswordSchema.safeParse({ token: 't', password }),
    'operator invite accept': (password: string) => acceptInviteSchema.safeParse({ password }),
    'admin invite accept': (password: string) => acceptAdminInviteSchema.safeParse({ password }),
    'operator self-registration': (password: string) =>
      registerOperatorSchema.safeParse({
        email: 'a@b.com',
        password,
        businessName: 'Acme Parking',
      }),
  }

  const names = Object.keys(setters) as (keyof typeof setters)[]

  it.each(names)('%s accepts a password exactly at the floor', (name) => {
    expect(setters[name]('a'.repeat(PASSWORD_MIN)).success).toBe(true)
  })

  it.each(names)('%s refuses one character below the floor', (name) => {
    expect(setters[name]('a'.repeat(PASSWORD_MIN - 1)).success).toBe(false)
  })

  it.each(names)('%s accepts a password exactly at the ceiling', (name) => {
    expect(setters[name]('a'.repeat(PASSWORD_MAX)).success).toBe(true)
  })

  /**
   * The regression that matters. Any setter with a ceiling ABOVE reset's would let someone
   * create a credential they are then permanently unable to change.
   */
  it.each(names)('%s refuses one character above the ceiling, like reset does', (name) => {
    expect(setters[name]('a'.repeat(PASSWORD_MAX + 1)).success).toBe(false)
  })

  /**
   * Sign-in is deliberately outside the policy: it VERIFIES a credential rather than sets
   * one, so a bound here would lock out anyone already holding a longer password — which is
   * exactly the situation the 200-character ceiling could have created.
   */
  it('leaves sign-in unbounded', () => {
    expect(signInSchema.safeParse({ email: 'a@b.com', password: 'a' }).success).toBe(true)
    expect(
      signInSchema.safeParse({ email: 'a@b.com', password: 'a'.repeat(PASSWORD_MAX + 100) }).success,
    ).toBe(true)
  })
})
