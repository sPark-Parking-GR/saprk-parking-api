import { applyTestEnv } from './env'

// Runs in every worker before the test framework is installed: globalSetup's process.env
// mutations do not cross into worker processes, and PrismaClient reads DATABASE_URL at
// construction time.
applyTestEnv()
