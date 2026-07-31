import fastifyHelmet from '@fastify/helmet'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { parseCorsOrigin, parseTrustProxy } from './config/env.schema'

async function bootstrap() {
  // Read straight from process.env: the adapter has to exist before Nest can build the
  // container that would provide ConfigService. The value is still schema-validated at
  // module init, so a malformed setting fails the boot either way.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: parseTrustProxy(process.env['TRUST_PROXY']) }),
    {
      rawBody: true,
      bufferLogs: true,
    },
  )
  app.useLogger(app.get(Logger))

  const config = app.get(ConfigService)
  const isProduction = config.get<string>('NODE_ENV') === 'production'

  // Pure JSON API: no HTML is ever served, so lock the CSP down to "load nothing" rather
  // than adopting helmet's browser-page defaults (self scripts/styles/fonts are moot here).
  // crossOriginResourcePolicy is relaxed to 'cross-origin' because helmet's 'same-origin'
  // default lets browsers block the web dashboard (a different origin) from reading
  // responses even though enableCors() below already authorizes it — CORS_ORIGIN remains
  // the single source of truth for which origins may call this API.
  // crossOriginEmbedderPolicy is left off (helmet's own default): it governs whether a
  // *document* can embed cross-origin subresources, which is meaningless for a JSON API
  // and would gain nothing while risking mobile/web fetch() calls that don't expect it.
  // HSTS only makes sense once TLS is actually terminated in front of this service, so it
  // is gated on production; sending it locally over plain HTTP would be a no-op anyway but
  // stays explicit and consistent with apps/web/next.config.ts's own isProd gate.
  // apps/api's own `fastify` resolves to 4.29.1 while @nestjs/platform-fastify pins a nested
  // fastify@4.28.1 (pre-existing pnpm-lock.yaml split, not introduced here); their generated
  // FastifyInstance generics disagree structurally, so register()'s plugin parameter rejects
  // @fastify/helmet's type even though both are real, ABI-compatible Fastify 4.x instances at
  // runtime. Route around the mismatch narrowly instead of loosening the file to `any`.
  const registerPlugin = app.register.bind(app) as (
    plugin: unknown,
    opts?: unknown,
  ) => Promise<unknown>
  await registerPlugin(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    strictTransportSecurity: isProduction
      ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
      : false,
  })

  app.setGlobalPrefix('api/v1')
  app.enableCors({ origin: parseCorsOrigin(config.get<string>('CORS_ORIGIN')) })
  await app.listen(config.get<number>('PORT') ?? 3001, '0.0.0.0')
}

bootstrap()
