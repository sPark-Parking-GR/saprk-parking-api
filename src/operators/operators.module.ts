import { Module } from '@nestjs/common'
import { OperatorsController } from './operators.controller'
import { OperatorsService } from './operators.service'

@Module({
  controllers: [OperatorsController],
  providers: [OperatorsService],
})
export class OperatorsModule {}
