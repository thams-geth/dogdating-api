import { z } from 'zod';
export const reportInput=z.object({subjectType:z.enum(['user','dog','media','message','meetup']),subjectId:z.string().uuid(),category:z.enum(['harassment','unsafe_behavior','fake_profile','animal_welfare','spam','other']),details:z.string().trim().min(5).max(2000)}).strict();
export const ticketInput=z.object({category:z.enum(['account','technical','privacy','safety','other']),message:z.string().trim().min(5).max(4000)}).strict();
export const supportMessage=z.object({message:z.string().trim().min(1).max(4000)}).strict();
export const appealInput=z.object({actionId:z.string().uuid(),statement:z.string().trim().min(5).max(4000)}).strict();
