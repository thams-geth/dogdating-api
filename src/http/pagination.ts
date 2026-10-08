import { z } from 'zod';
import { ApiError } from '../middleware/error.js';
export const pageQuery=z.object({
  limit:z.string().regex(/^[1-9]\d?$/).transform(Number).refine(n=>n<=50).default('20'),
  cursor:z.string().max(400).optional(),
}).strict();
export function decodeCursor(cursor:string|undefined,scope:string):string|null {
  if(!cursor)return null;
  try {
    if(!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();
    const value=z.object({id:z.string().uuid(),scope:z.literal(scope)}).strict().parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')));
    return value.id;
  }catch{throw new ApiError(400,'invalid-cursor','The cursor is invalid for this list.');}
}
export function page<T extends {id:string}>(rows:T[],limit:number,scope:string) {
  const items=rows.slice(0,limit);
  const nextCursor=rows.length>limit?Buffer.from(JSON.stringify({id:items.at(-1)!.id,scope})).toString('base64url'):null;
  return {items,nextCursor};
}
