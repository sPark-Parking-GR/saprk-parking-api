import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common'
import { Observable } from 'rxjs'
import { RequestContext } from '../context/request-context'
import type { AuthenticatedRequest } from '../types/request'

// Subscribing to `next.handle()` from *inside* `RequestContext.run` (rather than just
// calling it before returning the observable) is what makes the AsyncLocalStorage store
// survive into the route handler: AsyncLocalStorage only propagates to work started
// synchronously within the `run` callback, and Nest does not subscribe to the
// interceptor chain until after `intercept()` returns.
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const store = { ip: request.ip ?? null }

    return new Observable((subscriber) => {
      RequestContext.run(store, () => {
        next.handle().subscribe(subscriber)
      })
    })
  }
}
