import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { of } from 'rxjs'
import { RequestContext } from '../context/request-context'
import { RequestContextInterceptor } from './request-context.interceptor'

function contextWithIp(ip: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip }) }),
  } as unknown as ExecutionContext
}

describe('RequestContextInterceptor', () => {
  const interceptor = new RequestContextInterceptor()

  it('makes request.ip readable via RequestContext for the duration of the handler, then clears it', () => {
    let observedIp: string | null = null
    const handler: CallHandler = {
      handle: () => {
        observedIp = RequestContext.getIp()
        return of('ok')
      },
    }

    interceptor.intercept(contextWithIp('198.51.100.1'), handler).subscribe()

    expect(observedIp).toBe('198.51.100.1')
    expect(RequestContext.getIp()).toBeNull()
  })

  it('falls back to null when request.ip is absent', () => {
    let observedIp: string | null = 'unset' as unknown as null
    const handler: CallHandler = {
      handle: () => {
        observedIp = RequestContext.getIp()
        return of('ok')
      },
    }

    interceptor.intercept(contextWithIp(undefined), handler).subscribe()

    expect(observedIp).toBeNull()
  })

  it('propagates the handler result unchanged', () => {
    const handler: CallHandler = { handle: () => of({ id: 42 }) }
    const received: unknown[] = []

    interceptor.intercept(contextWithIp('198.51.100.1'), handler).subscribe((value) => {
      received.push(value)
    })

    expect(received).toEqual([{ id: 42 }])
  })
})
