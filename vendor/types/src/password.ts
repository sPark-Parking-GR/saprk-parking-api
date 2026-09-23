/**
 * The one password policy, shared by every surface that sets or changes a credential.
 *
 * These bounds used to be written out separately in each API DTO, each web form schema and
 * again in each web server action — eleven places — and they had already drifted: invite
 * accept, sign-up and reset capped at 128 while admin-invite accept and operator
 * self-registration allowed 200. That was not a harmless inconsistency. A platform admin
 * could set a 150-character password at invite acceptance and then find that
 * `resetPasswordSchema` refused to let them ever change it, because the reset ceiling was
 * lower than the ceiling the credential had been created under.
 *
 * Both comments justifying the 200 claimed the bound "matched the sign-in policy". Sign-in
 * is `min(1)` with no maximum, so it matched nothing — and it is deliberately unbounded,
 * because the check that must never reject is the one that lets an existing password
 * through. Sign-in and account deletion therefore stay outside this policy: they verify a
 * credential rather than set one, and tightening them would lock out anyone already holding
 * a longer password.
 */
export const PASSWORD_MIN = 8

/**
 * Not a security limit — length is the thing that helps, so the ceiling exists only to
 * bound the work a single scrypt hash can be asked to do. 128 is the lower of the two
 * values already in use, chosen so unifying can never widen what an endpoint accepts.
 */
export const PASSWORD_MAX = 128
