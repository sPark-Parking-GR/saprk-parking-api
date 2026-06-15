import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    rawBody: true,
  })
  app.setGlobalPrefix('api/v1')
  app.enableCors({ origin: process.env['CORS_ORIGIN']?.split(',') ?? true })
  await app.listen(process.env['PORT'] ?? 3001, '0.0.0.0')
}

bootstrap()
