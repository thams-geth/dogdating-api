import { z } from 'zod';
import { calendarDate } from '../dogs/dogs.schemas.js';
export const verificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('guardian') }).strict(),
  z.object({ kind: z.literal('dog'), dogId: z.string().uuid() }).strict(),
]);
const futureDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const healthSchema = z.object({
  recordType: z.enum(['vaccination','rabies','deworming','hip_score','elbow_score','eye_exam','cardiac_exam','dna_panel','vet_exam']),
  testedAt: calendarDate,
  expiresAt: futureDate.nullable().default(null),
  resultCode: z.string().regex(/^[a-z0-9_]{1,40}$/).nullable().default(null),
}).strict().refine(v => v.expiresAt === null || v.expiresAt >= v.testedAt, 'Expiry cannot predate the record.');
