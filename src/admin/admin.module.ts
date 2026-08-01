import { Module } from '@nestjs/common'
import { LifecycleModule } from '../lifecycle/lifecycle.module'
import { AdminLifecycleController } from './admin-lifecycle.controller'

// LifecycleModule was only ever reachable through JobsModule's purge worker, which the
// e2e harness stubs out and which no HTTP request touches. Importing it here is what puts
// the lifecycle on the wire.
@Module({
  imports: [LifecycleModule],
  controllers: [AdminLifecycleController],
})
export class AdminModule {}
