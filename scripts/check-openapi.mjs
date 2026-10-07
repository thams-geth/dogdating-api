import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const spec = YAML.parse(await readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));
const operationIds = new Set();
for (const item of Object.values(spec.paths)) {
  for (const operation of Object.values(item)) {
    if (!operation.operationId) continue;
    if (operationIds.has(operation.operationId)) throw new Error(`Duplicate operation: ${operation.operationId}`);
    operationIds.add(operation.operationId);
  }
}
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
    const target = value.$ref.slice(2).split('/').reduce((current, key) => current?.[key], spec);
    if (!target) throw new Error(`Unresolved reference: ${value.$ref}`);
  }
  Object.values(value).forEach(visit);
}
visit(spec);
console.log(`OpenAPI YAML parsed; ${operationIds.size} unique operations and local references checked.`);
