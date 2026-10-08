import { z } from 'zod';
export const sizes=z.enum(['toy','small','medium','large','giant']);
export const styles=z.enum(['wrestle','chase','parallel','fetch','sniff']);
export const calendarDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
 const date=new Date(`${value}T00:00:00.000Z`);return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10)===value && value<=new Date().toISOString().slice(0,10);
},'Date must be a real calendar date no later than today');
export const dogFieldsSchema=z.object({name:z.string().trim().min(1).max(40),sex:z.enum(['male','female']),sizeClass:sizes,
 dateOfBirth:calendarDate.nullable().optional(),dobPrecision:z.enum(['exact','month','year','estimate']).optional(),
 neutered:z.boolean().nullable().optional(),neuteredAt:calendarDate.nullable().optional(),weightG:z.number().int().min(500).max(120000).nullable().optional(),bio:z.string().trim().max(300).nullable().optional(),
}).strict();
export const createDogSchema=dogFieldsSchema.extend({householdId:z.string().uuid()});
export const updateDogSchema=dogFieldsSchema.partial().refine(value=>Object.keys(value).length>0);
export function validDogDates(value:z.infer<typeof dogFieldsSchema>){
 if(value.neuteredAt && (value.neutered!==true || (value.dateOfBirth && value.neuteredAt<value.dateOfBirth)))return false;
 return true;
}
const unique=<T>(values:T[])=>new Set(values).size===values.length;
export const breedsSchema=z.object({breeds:z.array(z.object({breedId:z.string().uuid(),percentage:z.number().int().min(1).max(100)}).strict()).min(1).max(4)})
 .strict().refine(value=>unique(value.breeds.map(b=>b.breedId)) && value.breeds.reduce((sum,b)=>sum+b.percentage,0)===100);
const scale=z.number().int().min(1).max(5);
export const temperamentSchema=z.object({questionnaireVersion:z.literal(1),energy:scale,
 playStyle:z.array(styles).min(1).max(5).refine(unique),dogReactivity:scale,humanReactivity:scale,resourceGuarding:scale,
 recallReliability:scale,sizeTolerance:z.array(sizes).min(1).max(5).refine(unique),needsToKnow:z.string().trim().max(500).default(''),}).strict();
export const dogPreferencesSchema=z.object({maxDistanceBucket:z.enum(['under_2_km','km_2_5','km_5_10','km_10_25','over_25_km']).default('km_5_10'),
 sizeClasses:z.array(sizes).max(5).refine(unique).default([]),ageMinMonths:z.number().int().min(0).max(360).nullable().default(null),ageMaxMonths:z.number().int().min(0).max(360).nullable().default(null),
 energyMin:scale.nullable().default(null),energyMax:scale.nullable().default(null),playStyles:z.array(styles).max(5).refine(unique).default([]),
 minVerificationTier:z.number().int().min(0).max(4).default(1),parallelWalkOnly:z.boolean().default(false),acceptsReactive:z.boolean().default(false),})
 .strict().refine(v=>(v.ageMinMonths===null||v.ageMaxMonths===null||v.ageMinMonths<=v.ageMaxMonths) && (v.energyMin===null||v.energyMax===null||v.energyMin<=v.energyMax) && (!v.acceptsReactive||v.parallelWalkOnly));
export const availabilitySchema=z.object({timezone:z.string().max(64).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}),
 windows:z.array(z.object({dayOfWeek:z.number().int().min(0).max(6),startMin:z.number().int().min(0).max(1439),endMin:z.number().int().min(1).max(1440)}).strict().refine(w=>w.endMin>w.startMin)).max(21),
}).strict().refine(v=>{
 const sorted=[...v.windows].sort((a,b)=>a.dayOfWeek-b.dayOfWeek||a.startMin-b.startMin);
 return sorted.every((item,i)=>i===0||sorted[i-1]!.dayOfWeek!==item.dayOfWeek||sorted[i-1]!.endMin<=item.startMin);
});
export const beaconSchema=z.object({durationMinutes:z.number().int().min(1).max(90)}).strict();
