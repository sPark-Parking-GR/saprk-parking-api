import { z } from 'zod'

// A full replace, not a delta: the caller sends the set it wants to end up with, so two
// concurrent edits cannot interleave into a state neither asked for. Duplicates are
// tolerated and collapsed by the service — the request still describes one clear set.
export const replaceManagersSchema = z.object({
  userIds: z.array(z.string().min(1)).max(100),
})

export type ReplaceManagersDto = z.infer<typeof replaceManagersSchema>
