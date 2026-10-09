import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import { ApiError } from '../../middleware/error.js';
import { policySchema,type AppPolicy } from './policy.js';

// Mounted at /v1 after public bootstrap/help/area routes and before product
// routes. Safety, privacy, auth and policy access remain usable by old clients.
const exempt=/^\/(auth(?:\/|$)|privacy(?:\/|$)|legal(?:\/|$)|reports(?:\/|$)|support(?:\/|$)|me\/(blocks|safety-notices|appeals|incident-reviews|data-exports|deletion-requests)(?:\/|$))/;
export function updateGate(database:Pool,staticPolicy?:AppPolicy):RequestHandler{return async(req,_res,next)=>{
 try{
  if(exempt.test(req.path))return next();
  let policy=staticPolicy;
  if(!policy){
   let raw:unknown;try{raw=(await database.query('SELECT policy FROM ops.app_release_policy WHERE singleton')).rows[0]?.policy;}
   catch{throw new ApiError(503,'release-policy-unavailable','Current release policy is unavailable.');}
   const parsed=policySchema.safeParse(raw);if(!parsed.success)throw new ApiError(503,'release-policy-unavailable','Current release policy is unavailable.');policy=parsed.data;
  }
  const platform=req.get('X-App-Platform'),buildText=req.get('X-App-Build');
  if(!platform&&!buildText&&policy.android.minimumBuild===1&&policy.ios.minimumBuild===1)return next();
  if(!platform||!buildText)throw new ApiError(400,'app-build-required','Send X-App-Platform and X-App-Build for this request.');
  if(!['android','ios'].includes(platform)||!/^[1-9]\d{0,9}$/.test(buildText)||!Number.isSafeInteger(Number(buildText)))throw new ApiError(400,'invalid-app-build','Client platform or build is invalid.');
  if(Number(buildText)<policy[platform as 'android'|'ios'].minimumBuild)throw new ApiError(426,'update-required','Update the app before using this feature. Fetch /v1/app/bootstrap for the store link.');
  next();
 }catch(error){next(error);}
};}
