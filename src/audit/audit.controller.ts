import { Controller, Get, Query } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { RequirePermission } from '../auth/decorators/require-permission.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { AuditService } from './audit.service'
import { listAuditLogSchema, type ListAuditLogDto } from './dto/audit.dto'

@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermission('platform:tenant.read')
  @Get()
  list(
    @Query(new ZodValidationPipe(listAuditLogSchema)) query: ListAuditLogDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.audit.list(user, query)
  }
}
