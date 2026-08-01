import { Module, type Type } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino'
import { AppModule } from '../../src/app.module'
import { IngestionModule } from '../../src/ingestion/ingestion.module'
import { JobsModule } from '../../src/jobs/jobs.module'
import { PrismaService } from '../../src/prisma/prisma.service'

// JobsModule and IngestionModule exist only to register BullMQ schedulers and workers on
// boot. Left in, every suite would install a repeating `release-expired-holds` job that
// mutates booking rows underneath the assertions, and leave Redis workers holding the
// process open after the last test. Nothing else in the container depends on either.
@Module({})
class NoJobsModule {}

@Module({})
class NoIngestionModule {}

// nestjs-pino writes a line per request straight to fd 1, which jest cannot capture and
// which buries the reporter under a JSON blob per assertion. Overriding the params the
// module resolves keeps the request-logging middleware installed exactly as in production
// and only mutes its output; it also drops the pino-pretty transport, whose worker thread
// would otherwise outlive the suite.
const SILENT_LOGGER_PARAMS: Params = { pinoHttp: { level: 'silent' } }

export interface TestApp {
  app: NestFastifyApplication
  prisma: PrismaService
}

export interface TestAppOptions {
  /**
   * Replaces the stub that IngestionModule is swapped for, so a suite that needs the
   * ingestion ROUTES can supply the real controller over fake queue-backed services —
   * without reinstating the BullMQ workers the stub exists to keep out.
   */
  ingestionModule?: Type<unknown>
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideModule(JobsModule)
    .useModule(NoJobsModule)
    .overrideModule(IngestionModule)
    .useModule(options.ingestionModule ?? NoIngestionModule)
    .overrideProvider(PARAMS_PROVIDER_TOKEN)
    .useValue(SILENT_LOGGER_PARAMS)
    .compile()

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
  app.useLogger(false)
  // Mirrors main.ts, so supertest paths are the ones clients actually call.
  app.setGlobalPrefix('api/v1')

  await app.init()
  await app.getHttpAdapter().getInstance().ready()

  return { app, prisma: app.get(PrismaService) }
}
