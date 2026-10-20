import { z } from 'zod'
export const fileEntity = z.enum(['lead', 'contact', 'company', 'deal', 'activity', 'import'])
export const fileRef = z.object({ entityType: fileEntity, entityId: z.uuid() })
export const optionalFileRef = fileRef.partial().refine((v) => Boolean(v.entityType) === Boolean(v.entityId), 'Choose a record')
export const fileListQuery = optionalFileRef.extend({ deleted: z.enum(['true', 'false']).optional() })
export const uploadIntentSchema = optionalFileRef.extend({ name: z.string().trim().min(1).max(255), size: z.number().int().positive(), contentType: z.string().max(150).optional() })
export const fileLinkParams = z.object({ id: z.uuid(), entityType: fileEntity, entityId: z.uuid() })
