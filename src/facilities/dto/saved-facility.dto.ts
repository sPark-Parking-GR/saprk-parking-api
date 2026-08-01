import { z } from 'zod'

export const saveFacilitySchema = z.object({
  facilityId: z.string().min(1).max(64),
})

export type SaveFacilityDto = z.infer<typeof saveFacilitySchema>
