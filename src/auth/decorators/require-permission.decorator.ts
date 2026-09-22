import { SetMetadata } from '@nestjs/common'
import type { PlatformPermission } from '@spark/types'

export const PERMISSIONS_KEY = 'platform-permissions'

/**
 * Conjunctive, unlike @Roles: the caller must hold EVERY permission listed, not any one of
 * them. A capability gate that widens as you name more capabilities would be a trap.
 */
export const RequirePermission = (...permissions: PlatformPermission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions)
