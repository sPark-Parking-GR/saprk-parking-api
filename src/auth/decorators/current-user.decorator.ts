import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { AuthUser } from '@parqin/types'
import type { AuthenticatedRequest } from '../../common/types/request'

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>()
    return request.user
  },
)
