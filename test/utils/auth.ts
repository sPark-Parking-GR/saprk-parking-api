import { signJwt } from '@spark/auth'
import { UserRole as PrismaUserRole } from '@prisma/client'
import type { AuthUser, UserRole } from '@spark/types'
import { E2E_AUTH_SECRET } from '../setup/env'

const CONTRACT_ROLE: Record<PrismaUserRole, UserRole> = {
  [PrismaUserRole.USER]: 'user',
  [PrismaUserRole.OPERATOR_STAFF]: 'operator_staff',
  [PrismaUserRole.OPERATOR_ADMIN]: 'operator_admin',
  [PrismaUserRole.PLATFORM_ADMIN]: 'platform_admin',
  [PrismaUserRole.SUPER_ADMIN]: 'super_admin',
}

export function authUser(user: { id: string; email: string; role: PrismaUserRole }): AuthUser {
  return {
    id: user.id,
    email: user.email,
    role: CONTRACT_ROLE[user.role],
    emailVerified: true,
  }
}

/**
 * A token the running AuthGuard genuinely accepts, minted with the same signer and claim
 * shape AuthJsProvider uses. Signing directly rather than driving /auth/signin keeps the
 * fixture off the scrypt path, which costs ~400ms per user and verifies nothing these
 * suites are about.
 */
export function bearerToken(user: { id: string; email: string; role: PrismaUserRole }): string {
  const issuedAt = Math.floor(Date.now() / 1000)

  return signJwt(
    {
      sub: user.id,
      email: user.email,
      role: CONTRACT_ROLE[user.role],
      ev: true,
      typ: 'access',
      iat: issuedAt,
      exp: issuedAt + 900,
    },
    E2E_AUTH_SECRET,
  )
}
