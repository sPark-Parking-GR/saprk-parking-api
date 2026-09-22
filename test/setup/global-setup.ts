import { applyMigrations, recreateTestDatabase } from './database'
import { applyTestEnv } from './env'

export default async function globalSetup(): Promise<void> {
  const database = applyTestEnv()
  await recreateTestDatabase(database)
  applyMigrations(database)
}
