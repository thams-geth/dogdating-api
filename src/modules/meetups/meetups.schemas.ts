import { z } from 'zod';import { pageQuery } from '../../http/pagination.js';
const uuid=z.string().uuid(),date=z.string().datetime({offset:true}),revision=z.number().int().positive();
export const placeQuery=pageQuery.extend({metroId:uuid});
export const placeSuggestion=z.object({name:z.string().trim().min(2).max(120),kind:z.enum(['offleash_park','trail','fenced_area','venue','vet','other']),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),address:z.string().trim().min(3).max(300),metroId:uuid,isFenced:z.boolean(),hasWater:z.boolean()}).strict();
export const proposeInput=z.object({matchId:uuid,hostDogId:uuid,guestUserId:uuid,placeId:uuid,kind:z.enum(['parallel_walk','play','training','hike']),windowStart:date,windowEnd:date}).strict();
export const respondInput=z.discriminatedUnion('action',[
 z.object({action:z.literal('accept'),revision}).strict(),z.object({action:z.literal('decline'),revision}).strict(),
 z.object({action:z.literal('counter'),revision,placeId:uuid,windowStart:date,windowEnd:date}).strict()
]);
export const revisionInput=z.object({revision}).strict();
export const cancelInput=revisionInput.extend({reason:z.enum(['schedule_changed','not_comfortable','other'])});
export const reviewInput=z.object({showedUp:z.boolean(),onTime:z.boolean().nullable(),dogAsDescribed:z.number().int().min(1).max(5).nullable(),humanRespectful:z.number().int().min(1).max(5).nullable(),playCompatibility:z.number().int().min(1).max(5).nullable(),wouldRepeat:z.boolean(),incidentOccurred:z.boolean(),incidentType:z.enum(['injury','harassment','unsafe_behavior','other']).nullable(),privateNote:z.string().trim().max(2000).nullable(),publicNote:z.string().trim().max(500).nullable()}).strict().refine(v=>v.incidentOccurred?v.incidentType!==null:v.incidentType===null);

export const extendInput=revisionInput.extend({additionalMinutes:z.union([z.literal(15),z.literal(30),z.literal(60)])}).strict();
export const extensionResponseInput=revisionInput.extend({accept:z.boolean()}).strict();
