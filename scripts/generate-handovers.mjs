import { readFile, readdir, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { notes } from './handover-notes.mjs';
const check = process.argv.includes('--check');
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const spec = YAML.parse(await read('docs/openapi.yaml'));
const plan = await read('docs/API_PLAN.md');
const sections = [...plan.matchAll(/^### (M\d+) — (.+)\n([\s\S]*?)(?=^### M|^## 5\.|$(?![\s\S]))/gm)];
const ids = Object.keys(notes).sort();
const operations = Object.fromEntries(ids.map(id => [id, []]));
function moduleFor(path) {
  if (path.startsWith('/v1/me/blocks')) return 'M11';
  if (/^\/v1\/(health|ready|app\/.*|dogs\/breeds)$/.test(path)) return 'M01';
  if (path.startsWith('/v1/auth/')) return 'M02';
  if (/^\/v1\/(me(?:\/|$)|legal\/)/.test(path)) return 'M03';
  if (/\/media(?:\/|$)|\/health-records(?:\/|$)|^\/v1\/verifications(?:\/|$)/.test(path)) return 'M05';
  if (/^\/v1\/(households|household-invitations|dogs)(?:\/|$)/.test(path)) return 'M04';
  throw new Error(`Assign a handover module for ${path}`);
}
for (const [path, item] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(item)) {
  if (op.operationId) operations[moduleFor(path)].push({path, method:method.toUpperCase(), op});
}
function resolve(schema) {
  if (!schema?.$ref) return schema;
  const value = schema.$ref.slice(2).split('/').reduce((v,k) => v?.[k], spec);
  if (!value) throw new Error(`Missing ${schema.$ref}`);
  return resolve(value);
}
function shape(input, indent = 0) {
  const s = resolve(input);
  if (!s) return 'unknown';
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map(v=>JSON.stringify(v)).join(' | ');
  if (s.oneOf || s.anyOf) return (s.oneOf ?? s.anyOf).map(v=>shape(v,indent)).join(' | ');
  if (s.allOf) return s.allOf.map(v=>shape(v,indent)).join(' & ');
  if (Array.isArray(s.type)) return s.type.map(type=>shape({...s,type},indent)).join(' | ');
  let text;
  if (s.type === 'object' || s.properties) {
    const fields = Object.entries(s.properties ?? {});
    text = fields.length ? `{\n${fields.map(([key,v])=>`${' '.repeat(indent+2)}${key}${s.required?.includes(key)?'':'?'}: ${shape(v,indent+2)}`).join('\n')}\n${' '.repeat(indent)}}` : '{}';
  } else if (s.type === 'array') text = `Array<${shape(s.items,indent)}>`;
  else text = s.type ?? 'unknown';
  const constraints = ['format','pattern','minimum','maximum','minLength','maxLength','minItems','maxItems','uniqueItems','default','minProperties']
    .filter(k=>s[k]!==undefined).map(k=>`${k}=${JSON.stringify(s[k])}`);
  return text + (constraints.length ? ` /* ${constraints.join(', ')} */` : '');
}
function access({path,method,op}) {
  if (!op.security?.length) return 'Public';
  if (path === '/v1/dogs' && method === 'POST') return 'Owner/co-guardian of supplied household';
  if (path.includes('household-invitations')) return 'Signed-in intended recipient';
  if (path.includes('/verifications')) return method==='POST' && !path.includes('/withdraw') ? 'Caller; dog: owner/co-guardian' : 'Requester; dog: current member also';
  if (path.endsWith('/content')) return 'Uploader and current owner/co-guardian';
  if (path.includes('/members/') || path.endsWith('/invitations') || path.endsWith('/memorialise')) return 'Household owner';
  if (path.includes('/households/') || /\/dogs\/\{/.test(path) || /\/media\/\{/.test(path)) return method==='GET' ? 'Accepted household member' : 'Owner/co-guardian';
  return 'Signed-in caller';
}
async function errors(directories) {
  const values = new Map();
  for (const dir of directories) {
    const path = `src/modules/${dir}`;
    for (const file of await readdir(new URL(path+'/',root))) {
      if (!file.endsWith('.ts')) continue;
      const source = await read(`${path}/${file}`);
      for (const match of source.matchAll(/new ApiError\(\s*(\d+)\s*,\s*['"]([^'"]+)['"]\s*,\s*(['"])(.*?)\3/gs)) {
        values.set(`${match[1]}:${match[2]}`, {status:match[1],code:match[2],detail:match[4]});
      }
    }
  }
  return [...values.values()].sort((a,b)=>Number(a.status)-Number(b.status)||a.code.localeCompare(b.code));
}
const recovery = code => ({
 'invalid-otp':'Let the user correct the code or request a new one.',
 'invalid-session':'Coordinate refresh once if appropriate; if refresh fails, sign in again.',
 'display-name-required':'Ask for name and retry verification with the same valid code.',
 'location-consent-required':'Fetch and display the current location policy, obtain consent, then retry.',
 'location-change-limited':'GET location and display canChangeAt; do not loop retry.',
 'area-unavailable':'Reload areas and choose a selectable area in the account country.',
 'onboarding-incomplete':'GET /me/onboarding and route to nextAction.',
 'publication-incomplete':'Select the dog and refresh onboarding requirements.',
 'beacon-unavailable':'Refresh selected dog, publication, readiness and discovery preference.',
 'document-unavailable':'Show policy unavailable; backend needs reviewed published content.',
 'document-not-current':'Reload the policy and obtain explicit acceptance of its new version.',
 'upload-expired':'Create a new reservation and upload again.',
 'upload-consumed':'Read upload status before retrying; content is single-use.',
 'upload-incomplete':'Send bytes successfully before completing.',
 'upload-mismatch':'Recompute MIME, size and checksum from the same original bytes.',
 'invalid-image':'Ask for another valid JPEG/PNG within the limits.',
 'media-unavailable':'Show uploads unavailable; backend configuration is required.',
 'processor-busy':'Retry later with backoff while the reservation remains valid.',
 'last-owner':'Keep or appoint another accepted owner before removal/demotion.',
 'invitation-unavailable':'Ask the owner for a new invitation.',
 'already-member':'Refresh the household list; do not accept again.',
 'verification-final':'Refresh status; the request can no longer be withdrawn.',
 'invalid-dates':'Correct dates and their ordering.',
 'not-found':'Refresh the list/access state; avoid exposing whether another user owns the resource.',
 'forbidden':'Hide the unavailable action and refresh the user’s current household role.',
}[code] ?? 'Show a contextual error using code; correct input/state or respect the documented limit before retrying.');
const fence=(language,value)=>'```'+language+'\n'+value+'\n```';
const output = new Map();
for (const id of ids) {
  const n=notes[id], section=sections.find(s=>s[1]===id);
  if (!section) throw new Error(`Missing plan section ${id}`);
  const title=section[2].replace(/ \[.*\]$/,''), ops=operations[id];
  let md=`# ${id} — ${title}\n\n[Handover index](README.md) · [Shared client conventions](COMMON.md) · [OpenAPI](../openapi.yaml)\n\n## Status\n\n${n.status}\n\n${ops.length} implemented operations. This document describes the checked-in backend, not a deployed environment.\n\n## Screen flow\n\n${ops.length?'Current integration flow; readiness gates may stop progression.':'Proposed flow only; no working API is implied.'}\n\n`;
  md+=fence('mermaid','flowchart TD\n'+n.steps.map((step,i)=>`  S${i}["${step}"]`).join('\n')+'\n'+n.steps.slice(1).map((_,i)=>`  S${i} --> S${i+1}`).join('\n'))+'\n\n## Wireframe\n\n';
  const width=Math.max(...n.screen.map(s=>s.length))+2;
  md+=fence('text','+'+'-'.repeat(width)+'+\n'+n.screen.map(s=>'| '+s.padEnd(width-2)+' |').join('\n')+'\n+'+'-'.repeat(width)+'+')+'\n\n## Client behavior and integration limits\n\n';
  md+=n.guidance.map(s=>`- ${s}`).join('\n')+'\n';
  if (!ops.length) {
    md+='\n## Request, response and error status\n\nNo supported contract yet. Do not call the planned paths or use fallback/mock success in production. Schemas, status codes, error codes, authentication and retry behavior will be added with implementation. Generic route/auth failures are not a feature contract.\n\n## Planned scope\n\n'+section[3].trim()+'\n';
  } else {
    md+='\n## Endpoint summary\n\n| Method | Path | Access | Success |\n| --- | --- | --- | --- |\n';
    md+=ops.map(o=>`| ${o.method} | \`${o.path}\` | ${access(o)} | ${Object.keys(o.op.responses).filter(k=>/^2/.test(k)).join(', ')} |`).join('\n')+'\n';
    md+='\n## Examples\n\nIllustrative data only. Replace IDs with returned resource IDs and token/checksum placeholders with real local values. Examples are not seeded records, legal text or evidence. For examples without a response block, use the exact response shape in the endpoint section below.\n';
    for (const e of n.examples) {
      const [method,url]=e.request.split(' ');
      const endpoint=ops.find(o=>o.method===method && new RegExp('^'+o.path.replace(/\{[^}]+\}/g,'[^/]+')+'$').test(url.split('?')[0]));
      if(!endpoint)throw new Error(`Example does not match an implemented endpoint: ${e.request}`);
      const authorization=endpoint.op.security?.length?'\nAuthorization: Bearer <accessToken>':'';
      md+=`\n### ${e.title}\n\n${fence('http',e.request+authorization+(e.body?'\nContent-Type: application/json\n\n'+JSON.stringify(e.body,null,2):''))}\n`;
      if (e.response) md+=`\nResponse: HTTP ${e.status??200}\n\n${fence('json',JSON.stringify(e.response,null,2))}\n`;
    }
    md+='\n## Module errors\n\nAlso handle the [shared error contract](COMMON.md#errors). These are module-level codes; applicability depends on the endpoint and current state. HTTP status alone is insufficient.\n\n| HTTP | Code | Meaning | Client action |\n| --- | --- | --- | --- |\n';
    const es=await errors(n.sources);
    md+=(es.length?es.map(e=>`| ${e.status} | \`${e.code}\` | ${e.detail.replaceAll('|','\\|')} | ${recovery(e.code)} |`).join('\n'):'| — | — | No module-specific codes beyond shared validation/dependency errors. | Use shared handling. |')+'\n';
    md+='\n## Detailed request and response contracts\n\nShapes below are **type notation**, not JSON to send: `?` means optional, `|` means alternatives, and comments show constraints/defaults. Requests reject unknown write fields. JSON uses actual values. Runtime cross-field/business rules are in the client guidance above. The linked OpenAPI is the machine-readable source.\n';
    for (const o of ops) {
      md+=`\n### ${o.method} ${o.path}\n\nOperation: \`${o.op.operationId}\`. Access: ${access(o)}.\n`;
      if(o.op.summary)md+='\n'+o.op.summary+'.\n';
      if(o.op.parameters?.length){md+='\nParameters:\n\n';for(const p of o.op.parameters)md+=`- \`${p.name}\` (${p.in}, ${p.required?'required':'optional'}): ${fence('',shape(p.schema)).replaceAll('\n',' ').replaceAll('```','`')}\n`;}
      const content=o.op.requestBody?.content;
      if(content){for(const [mime,v]of Object.entries(content))md+=`\nRequest body (${mime}, ${o.op.requestBody.required?'required':'optional'}):\n\n${fence('text',shape(v.schema))}\n`;}
      else md+='\nRequest body: none.\n';
      for(const [status,r0]of Object.entries(o.op.responses)){if(!/^2/.test(status))continue;const r=resolve(r0);md+=`\nResponse HTTP ${status}:\n\n`;const c=r.content?.['application/json'];md+=c?fence('text',shape(c.schema))+'\n':'No response body.\n';}
    }
  }
  md+='\n---\n\nMaintained through `scripts/handover-notes.mjs`, `docs/API_PLAN.md`, OpenAPI and source error codes. Regenerate with `npm run docs:handovers`; verify with `npm run check:handovers`.\n';
  output.set(`docs/handovers/${id}.md`,md);
}
const index=`# Mobile and web developer handover\n\nStart with [shared conventions](COMMON.md) and the module for your screen. Every planned module has a document, a flow diagram and a wireframe. **Implemented foundations do not imply production launch readiness.**\n\n| Module | Handover | Status | APIs |\n| --- | --- | --- | --- |\n${ids.map(id=>`| ${id} | [${sections.find(s=>s[1]===id)[2].replace(/ \[.*\]$/,'')}](${id}.md) | ${operations[id].length?'Implemented foundation; see limitations':'Not implemented'} | ${operations[id].length} |`).join('\n')}\n\n## End-to-end wire diagram\n\n${fence('mermaid','flowchart TD\n  A["M01: Bootstrap and update state"] --> B["M02: Phone and OTP"]\n  B --> C["M03: Profile, policies and progress"]\n  C --> D["M04: Household and dog draft"]\n  D --> E["M05: Photos and verification intake"]\n  E --> F["M04: Consented city selection"]\n  F --> G["M03: Recompute missing prerequisites"]\n  G --> H{"Ready?"}\n  H -->|No| I["Show missing step or dependency unavailable"]\n  I --> G\n  H -->|Yes| J["M04: Publish / enable discovery preference"]\n  J -. planned .-> K["M06: Home and discovery"]\n  K -. planned .-> L["M07: Likes and connections"]\n  L -. planned .-> M["M08: Messages"]\n  M -. planned .-> N["M10: Meetups"]\n  N -. planned .-> O["M09/M11: Notifications, safety and support"]')}\n\nMedia approval, verification providers and reviewed legal documents are current onboarding blockers. Wireframes are integration sketches, not finished visual designs. Planned flows must remain disabled in public clients.\n\n## Keeping the handover current\n\n1. Update the implemented OpenAPI contract and module guidance in scripts/handover-notes.mjs.\n2. Add/update relevant tests and HTTP examples.\n3. Run npm run docs:handovers and npm run check:handovers. The check fails on missing or stale generated module docs.\n4. Commit the module with its handover and implementation status.\n\nContract reference: [OpenAPI](../openapi.yaml). Runnable examples: [requests.http](../requests.http). Backend scope/status: [implementation ledger](../IMPLEMENTATION.md).\n`;
output.set('docs/handovers/README.md',index);
const stale=[];
for(const [path,content]of output){if(check){if(await read(path).catch(()=>null)!==content)stale.push(path);}else await writeFile(new URL(path,root),content);}
if(stale.length)throw new Error(`Stale handovers: ${stale.join(', ')}. Run npm run docs:handovers.`);
console.log(`${check?'Checked':'Generated'} ${ids.length} module handovers covering ${Object.values(operations).flat().length} operations and their wire diagrams.`);
