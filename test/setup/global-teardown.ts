import { dropTestDatabase } from './database'
import { applyTestEnv } from './env'

export default async function globalTeardown(): Promise<void> {
  if (process.env['E2E_KEEP_DATABASE'] === 'true') return
  await dropTestDatabase(applyTestEnv())
}
