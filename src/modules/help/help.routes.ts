import { Router } from 'express';import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler.js';import { pageQuery } from '../../http/pagination.js';
import type { HelpService } from './help.service.js';
const slug=z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
export function helpRoutes(service:HelpService){const router=Router();
 router.get('/articles',asyncHandler(async(req,res)=>{const q=pageQuery.extend({locale:z.literal('en-IN').default('en-IN')}).parse(req.query);res.json(await service.publicList(q.limit,q.cursor));}));
 router.get('/articles/:slug',asyncHandler(async(req,res)=>{z.object({locale:z.literal('en-IN').default('en-IN')}).strict().parse(req.query);res.json(await service.publicArticle(slug.parse(req.params.slug)));}));return router;
}
