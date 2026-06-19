import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import {
  BookingNotFoundError,
  BookingStatusTransitionError,
  DomainError,
  FacilityFieldForbiddenError,
  FacilityNotFoundError,
  IdempotencyConflictError,
  NoApplicableTariffError,
  NoAvailabilityError,
  OperatorContextRequiredError,
  QuoteExpiredError,
} from '../errors/domain.errors'

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()

    const { status, body } = this.resolve(exception)

    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception))
    }

    void reply.status(status).send(body)
  }

  private resolve(exception: unknown): { status: number; body: Record<string, unknown> } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse()
      return {
        status: exception.getStatus(),
        body: typeof response === 'string' ? { message: response } : (response as Record<string, unknown>),
      }
    }

    const status = this.statusForDomainError(exception)
    if (status) {
      return { status, body: { message: (exception as DomainError).message } }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { message: 'Internal server error' },
    }
  }

  private statusForDomainError(exception: unknown): number | null {
    if (exception instanceof FacilityNotFoundError || exception instanceof BookingNotFoundError) {
      return HttpStatus.NOT_FOUND
    }
    if (
      exception instanceof OperatorContextRequiredError ||
      exception instanceof FacilityFieldForbiddenError
    ) {
      return HttpStatus.FORBIDDEN
    }
    if (
      exception instanceof NoAvailabilityError ||
      exception instanceof QuoteExpiredError ||
      exception instanceof BookingStatusTransitionError ||
      exception instanceof IdempotencyConflictError
    ) {
      return HttpStatus.CONFLICT
    }
    if (exception instanceof NoApplicableTariffError) {
      return HttpStatus.UNPROCESSABLE_ENTITY
    }
    if (exception instanceof DomainError) {
      return HttpStatus.BAD_REQUEST
    }
    return null
  }
}
