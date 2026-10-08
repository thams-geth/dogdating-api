import fs from 'node:fs';import YAML from 'yaml';
export const spec=YAML.parse(fs.readFileSync('docs/openapi.yaml','utf8'));
export const uuid={type:'string',format:'uuid'},str={type:'string'},date={type:'string',format:'date-time'},bool={type:'boolean'},seq={type:'string',pattern:'^[0-9]+$'};
export const nullable=s=>({anyOf:[s,{type:'null'}]}),obj=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const parameter=(name,schema,where='query',required=false)=>({name,in:where,required,schema});
export const paging=[parameter('limit',{type:'integer',minimum:1,maximum:50,default:20}),parameter('cursor',str)],idParam=[parameter('id',uuid,'path',true)];
export const list=items=>obj({items:{type:'array',items},nextCursor:nullable(str)});
export function add(path,method,id,response,parameters=[],body,status=200){
 const responses=response?{[status]:{description:'Success',content:{'application/json':{schema:response}}}}:{'204':{description:'Completed; no body'}};
 for(const code of [400,401,403,404,409,410,429,503])responses[code]={$ref:'#/components/responses/Problem'};
 const op={operationId:id,security:[{bearerAuth:[]}],parameters,responses};if(body)op.requestBody={required:true,content:{'application/json':{schema:body}}};(spec.paths[path]??={})[method]=op;
}
export const save=()=>fs.writeFileSync('docs/openapi.yaml',YAML.stringify(spec,{aliasDuplicateObjects:false}));
