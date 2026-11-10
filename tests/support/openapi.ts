import { type APIRequestContext, type APIResponse } from '@playwright/test';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

/** A fully resolved (no $ref left) OpenAPI document. */
export interface Spec {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  security?: Array<Record<string, string[]>>;
  responses: Record<string, ResponseObject>;
}

interface ResponseObject {
  headers?: Record<string, { required?: boolean; schema?: Record<string, unknown> }>;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = new WeakMap<object, ValidateFunction>();

/** Downloads the OpenAPI document the running API publishes and checks it is a valid OpenAPI 3 file. */
export async function loadSpec(request: APIRequestContext): Promise<{ spec: Spec; text: string }> {
  const response = await request.get('/api/openapi.yaml');
  if (response.status() !== 200) {
    throw new Error(`GET /api/openapi.yaml answered ${response.status()}`);
  }
  const text = await response.text();
  const resolved = await SwaggerParser.validate(YAML.parse(text) as never);
  return { spec: resolved as unknown as Spec, text };
}

export const operationsOf = (spec: Spec): Array<{ method: string; path: string; operation: Operation }> =>
  Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })));

const mediaType = (contentType: string | undefined): string => (contentType ?? '').split(';')[0]!.trim().toLowerCase();

/**
 * Checks one real response against the spec and returns every way it does not match (empty = it conforms):
 * the operation and status must be documented, the content type must match, the body must fit the schema,
 * and every header the spec marks as required must be present and valid.
 */
export async function contractProblems(
  response: APIResponse,
  method: string,
  path: string,
  spec: Spec,
): Promise<string[]> {
  const problems: string[] = [];
  const operation = spec.paths[path]?.[method.toLowerCase()];
  if (!operation) {
    return [`${method} ${path} is not documented`];
  }
  const status = String(response.status());
  const documented = operation.responses[status];
  if (!documented) {
    return [`${method} ${path} answered ${status}, which the spec does not list (it lists ${Object.keys(operation.responses).join(', ')})`];
  }

  const text = await response.text();
  if (documented.content) {
    const type = mediaType(response.headers()['content-type']);
    const schemaFor = Object.entries(documented.content).find(([name]) => name.toLowerCase() === type);
    if (!schemaFor) {
      problems.push(`${status}: content type "${type}" is not one of ${Object.keys(documented.content).join(', ')}`);
    } else if (type === 'application/json' && schemaFor[1].schema) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        problems.push(`${status}: the body is not valid JSON`);
      }
      if (body !== undefined) {
        const schema = schemaFor[1].schema;
        let validate = compiled.get(schema);
        if (!validate) {
          validate = ajv.compile(schema);
          compiled.set(schema, validate);
        }
        if (!validate(body)) {
          for (const error of validate.errors ?? []) {
            problems.push(`${status}: body${error.instancePath} ${error.message}`);
          }
        }
      }
    }
  } else if (text !== '') {
    problems.push(`${status}: the spec says there is no body, but one of ${text.length} characters came back`);
  }

  for (const [name, header] of Object.entries(documented.headers ?? {})) {
    const value = response.headers()[name.toLowerCase()];
    if (value === undefined) {
      if (header.required) {
        problems.push(`${status}: required header ${name} is missing`);
      }
      continue;
    }
    const schema = header.schema as { type?: string; minimum?: number; enum?: string[] } | undefined;
    if (schema?.type === 'integer' && !/^\d+$/.test(value)) {
      problems.push(`${status}: header ${name} should be a whole number but is "${value}"`);
    }
    if (schema?.type === 'integer' && schema.minimum !== undefined && Number(value) < schema.minimum) {
      problems.push(`${status}: header ${name} is ${value}, below the minimum ${schema.minimum}`);
    }
    if (schema?.enum && !schema.enum.includes(value)) {
      problems.push(`${status}: header ${name} is "${value}", expected one of ${schema.enum.join(', ')}`);
    }
  }
  return problems;
}
