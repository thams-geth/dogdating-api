import { ApiError } from '../../middleware/error.js';
import { Router } from 'express';import type { Pool } from 'pg';
import { bootstrap,bootstrapQuery } from './app.service.js';import { countries,policySchema,type AppPolicy } from './policy.js';import { asyncHandler } from '../../http/async-handler.js';
export function appRoutes(policy:AppPolicy,database?:Pool):Router {
 const router=Router();
 router.get('/bootstrap',asyncHandler(async(req,res)=>{
  const input=bootstrapQuery.parse(req.query);let effective=policy;
  if(database){const row=(await database.query('SELECT policy FROM ops.app_release_policy WHERE singleton')).rows[0];const parsed=policySchema.safeParse(row?.policy);if(!parsed.success)throw new ApiError(503,'release-policy-unavailable','Current release policy is unavailable.');effective=parsed.data;}
  const result=bootstrap(input,effective);
  if(database&&input.countryCode==='IN'){
   const rows=(await database.query(`SELECT DISTINCT ON(purpose) purpose,version FROM identity.policy_documents WHERE country_code=$1 AND locale=$2 AND published_at<=now() AND purpose IN ('terms','privacy','community') ORDER BY purpose,published_at DESC,id DESC`,[input.countryCode,result.effectiveLocale])).rows;
   for(const row of rows)(result.legal as Record<string,string|null>)[`${row.purpose}Version`]=row.version;
  }
  res.json(result);
 }));
 router.get('/countries',(_req,res)=>res.json({countries}));return router;
}
