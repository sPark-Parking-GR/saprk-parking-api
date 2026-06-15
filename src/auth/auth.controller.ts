import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { AuthService } from './auth.service'
import { Public } from './decorators/public.decorator'
import {
  refreshSchema,
  signInSchema,
  signUpSchema,
  type RefreshDto,
  type SignInDto,
  type SignUpDto,
} from './dto/auth.dto'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('sign-up')
  signUp(@Body(new ZodValidationPipe(signUpSchema)) body: SignUpDto) {
    return this.auth.signUp(body)
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('sign-in')
  signIn(@Body(new ZodValidationPipe(signInSchema)) body: SignInDto) {
    return this.auth.signIn(body)
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshDto) {
    return this.auth.refreshToken(body.refreshToken)
  }

  @Public()
  @HttpCode(204)
  @Post('sign-out')
  async signOut(@Headers('authorization') authorization: string | undefined) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
    if (!token) throw new UnauthorizedException('Missing authentication token')
    await this.auth.signOut(token)
  }
}
