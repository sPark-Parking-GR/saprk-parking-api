import { Controller, Get, Query } from '@nestjs/common'
import { Roles } from '../auth/decorators/roles.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { AuditService } from './audit.service'
import { listAuditLogSchema, type ListAuditLogDto } from './dto/audit.dto'

@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles('platform_admin')
  @Get()
  list(@Query(new ZodValidationPipe(listAuditLogSchema)) query: ListAuditLogDto) {
    return this.audit.list(query)
  }
}
