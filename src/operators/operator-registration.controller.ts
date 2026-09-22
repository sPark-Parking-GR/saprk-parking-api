import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Public } from '../auth/decorators/public.decorator'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  registerOperatorSchema,
  type RegisterOperatorDto,
} from './dto/operator-registration.dto'
import { OperatorRegistrationService } from './operator-registration.service'

/**
 * Public operator registration. Not under `/admin/*` for the obvious reason — the caller has
 * no account yet — and throttled to the same 5/minute as `/auth/sign-up`, which it is the
 * operator-shaped equivalent of.
 */
@Controller('auth/register')
export class OperatorRegistrationController {
  constructor(private readonly registration: OperatorRegistrationService) {}

  /**
   * Lets the sign-up page know whether to render at all, so a closed platform shows an
   * explanation rather than a form that always fails on submit.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('operator/availability')
  availability() {
    return { enabled: this.registration.isEnabled() }
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(201)
  @Post('operator')
  register(@Body(new ZodValidationPipe(registerOperatorSchema)) body: RegisterOperatorDto) {
    return this.registration.register(body)
  }
}
