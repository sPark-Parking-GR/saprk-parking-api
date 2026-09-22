import { Controller, Get, Param } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequireOrgPermission } from '../auth/decorators/require-org-permission.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { OperatorSupportService } from './operator-support.service'

// No operator_staff: the answer is a plan term, and org:billing.view is the one scope a
// staff membership can never hold (see STAFF_FORBIDDEN_SCOPES).
@Roles('operator_admin', 'platform_admin', 'super_admin')
@RequireOrgPermission('org:billing.view')
@Controller('operators/:operatorId/support-tier')
export class OperatorSupportController {
  constructor(private readonly support: OperatorSupportService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  supportTier(@Param('operatorId') operatorId: string, @CurrentUser() user: AuthUser) {
    return this.support.supportTier(user, operatorId)
  }
}
