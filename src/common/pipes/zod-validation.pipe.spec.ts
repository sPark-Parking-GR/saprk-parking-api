import { BadRequestException } from '@nestjs/common'
import { z } from 'zod'
import { ZodValidationPipe } from './zod-validation.pipe'

describe('ZodValidationPipe', () => {
  const schema = z.object({ name: z.string().min(2), age: z.coerce.number().int() })
  const pipe = new ZodValidationPipe(schema)

  it('returns parsed and coerced value for valid input', () => {
    const result = pipe.transform({ name: 'Nikos', age: '30' })
    expect(result).toEqual({ name: 'Nikos', age: 30 })
  })

  it('throws BadRequestException with field errors for invalid input', () => {
    expect(() => pipe.transform({ name: 'x', age: 'abc' })).toThrow(BadRequestException)

    try {
      pipe.transform({ name: 'x', age: 'abc' })
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        message: string
        errors: Array<{ path: string }>
      }
      expect(response.message).toBe('Validation failed')
      expect(response.errors.map((e) => e.path).sort()).toEqual(['age', 'name'])
    }
  })
})
