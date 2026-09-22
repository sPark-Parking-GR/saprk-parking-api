import { SetMetadata } from '@nestjs/common'
import type { OrgPermission } from '@spark/types'

export const ORG_PERMISSIONS_KEY = 'org-permissions'

/**
 * Requires an org scope WITHIN the operator the caller belongs to.
 *
 * Conjunctive, matching @RequirePermission: several scopes on one route means all of them.
 *
 * This is a FLOOR, not the whole check — see OrgPermissionGuard for why, and use
 * OperatorAccessService.assertScope in any service that has resolved a specific operator.
 */
export const RequireOrgPermission = (...permissions: OrgPermission[]) =>
  SetMetadata(ORG_PERMISSIONS_KEY, permissions)
