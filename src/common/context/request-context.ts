import { AsyncLocalStorage } from 'async_hooks'

interface RequestContextStore {
  ip: string | null
}

const storage = new AsyncLocalStorage<RequestContextStore>()

// Makes the inbound request's IP reachable from service/repository code that has no
// HTTP request object in scope, without adding an `ip` parameter to every audited
// method. Populated once per request by RequestContextInterceptor.
export const RequestContext = {
  run<T>(store: RequestContextStore, callback: () => T): T {
    return storage.run(store, callback)
  },

  getIp(): string | null {
    return storage.getStore()?.ip ?? null
  },
}
