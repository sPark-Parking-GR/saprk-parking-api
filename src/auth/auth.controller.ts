import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { AuthUser } from '@spark/types'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { AccountDeletionService } from './account-deletion.service'
import { AuthService } from './auth.service'
import { PasswordResetService } from './password-reset.service'
import { CurrentUser } from './decorators/current-user.decorator'
import { Public } from './decorators/public.decorator'
import {
  deleteAccountSchema,
  forgotPasswordSchema,
  refreshSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  updateProfileSchema,
  type DeleteAccountDto,
  type ForgotPasswordDto,
  type RefreshDto,
  type ResetPasswordDto,
  type SignInDto,
  type UpdateProfileDto,
  type SignUpDto,
} from './dto/auth.dto'

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly accountDeletion: AccountDeletionService,
  ) {}

  /**
   * Authenticated, and scoped to the caller's OWN row — the id comes from the verified
   * token, never from the body, so this cannot be pointed at another account.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Patch('me')
  updateProfile(
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.auth.updateProfile(user.id, body.displayName)
  }

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

  // 204 unconditionally, and never the token: whether the address has an account is not
  // something an unauthenticated caller gets to learn from status, body or timing.
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(204)
  @Post('forgot-password')
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordDto,
  ): Promise<void> {
    await this.passwordReset.request(body.email)
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(204)
  @Post('reset-password')
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordDto,
  ): Promise<void> {
    await this.passwordReset.reset(body.token, body.password)
  }

  @Public()
  @HttpCode(204)
  @Post('sign-out')
  async signOut(@Headers('authorization') authorization: string | undefined) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
    if (!token) throw new UnauthorizedException('Missing authentication token')
    await this.auth.signOut(token)
  }

  // Self-service account deletion, required in-app by App Store Review Guideline 5.1.1(v).
  // Not @Public: the guard must resolve the caller, because the account acted on is always
  // the caller's own — there is no id in the request for anyone to tamper with. POST
  // rather than DELETE so the password travels in a body; a URL or query string is the one
  // place a credential must never be. Throttled to the same 3/min as forgot-password: a
  // wrong password here is an authentication attempt like any other. No @Roles gate: every
  // role may call this, because the service branches on role — a consumer's whole account
  // is tombstoned, while an operator/admin who also uses the app as a driver instead gets
  // just their mobile-side data cleared, leaving the web identity that role depends on
  // untouched. See AccountDeletionService.deleteOwnAccount.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(204)
  @Post('delete-account')
  async deleteAccount(
    @CurrentUser() user: AuthUser,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(deleteAccountSchema)) body: DeleteAccountDto,
  ): Promise<void> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
    if (!token) throw new UnauthorizedException('Missing authentication token')
    await this.accountDeletion.deleteOwnAccount(user, body.password, token)
  }
}
