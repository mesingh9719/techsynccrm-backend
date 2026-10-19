import { z } from 'zod'
import { contactSchema, demoSchema, demoSlotsQuerySchema, newsletterSchema, tokenSchema } from '../validators/public.validators.js'

/**
 * OpenAPI 3.1 document assembled from the same zod schemas the routes validate with, so the docs
 * can't drift from the code. Served at GET /api/docs.json outside production.
 * Add an entry to `operations` when you add a documented route.
 */

// OpenAPI 3.1 uses JSON Schema 2020-12, zod's default target.
const toSchema = (schema) => {
  const { $schema: _omit, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  return json
}

const envelope = (data) => ({
  type: 'object',
  properties: { success: { type: 'boolean', const: true }, data },
  required: ['success', 'data'],
})

const errorResponse = {
  description: 'Error',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', const: false },
          error: {
            type: 'object',
            properties: { message: { type: 'string' }, code: { type: 'string' }, details: { type: 'object' } },
            required: ['message'],
          },
        },
      },
    },
  },
}

const operations = [
  {
    method: 'get',
    path: '/meta/plans',
    summary: 'Plan catalogue: limits (null = unlimited) and features per plan',
    tag: 'Plans',
    response: {
      type: 'object',
      properties: {
        plans: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', enum: ['starter', 'growth', 'business', 'enterprise'] },
              name: { type: 'string' },
              trialDays: { type: 'integer' },
              limits: { type: 'object', additionalProperties: { type: ['integer', 'null'] } },
              features: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  {
    method: 'post',
    path: '/public/contact',
    summary: 'Submit the contact form',
    tag: 'Marketing forms',
    body: contactSchema,
    response: { type: 'object', properties: { ticketId: { type: 'string', example: 'TS-482913' } } },
    status: 201,
  },
  {
    method: 'get',
    path: '/public/demo-slots',
    summary: 'Available demo slots for a date (IST)',
    tag: 'Marketing forms',
    query: demoSlotsQuerySchema,
    response: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        timezone: { type: 'string' },
        slots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              start: { type: 'string', format: 'date-time' },
              available: { type: 'boolean' },
              reason: { type: ['string', 'null'], enum: ['unavailable', 'too_soon', 'full', null] },
            },
          },
        },
      },
    },
  },
  {
    method: 'post',
    path: '/public/demo-requests',
    summary: 'Book a demo',
    tag: 'Marketing forms',
    body: demoSchema,
    response: { type: 'object', properties: { confirmationId: { type: 'string' }, slotStart: { type: 'string', format: 'date-time' } } },
    status: 201,
  },
  {
    method: 'post',
    path: '/public/newsletter',
    summary: 'Subscribe to the newsletter (sends a confirmation email)',
    tag: 'Marketing forms',
    body: newsletterSchema,
    response: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    method: 'post',
    path: '/public/newsletter/confirm',
    summary: 'Confirm a newsletter subscription',
    tag: 'Marketing forms',
    body: tokenSchema,
    response: { type: 'object', properties: { confirmed: { type: 'boolean' }, email: { type: 'string' } } },
  },
  {
    method: 'post',
    path: '/public/newsletter/unsubscribe',
    summary: 'Unsubscribe from the newsletter',
    tag: 'Marketing forms',
    body: tokenSchema,
    response: { type: 'object', properties: { unsubscribed: { type: 'boolean' }, email: { type: 'string' } } },
  },
]

function queryParameters(schema) {
  const json = toSchema(schema)
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({ name, in: 'query', required: json.required?.includes(name) ?? false, schema: s }))
}

let cached = null

export function getOpenApiDocument() {
  if (cached) return cached
  const paths = {}
  for (const op of operations) {
    paths[op.path] ??= {}
    paths[op.path][op.method] = {
      summary: op.summary,
      tags: [op.tag],
      ...(op.query && { parameters: queryParameters(op.query) }),
      ...(op.body && { requestBody: { required: true, content: { 'application/json': { schema: toSchema(op.body) } } } }),
      responses: {
        [op.status ?? 200]: { description: 'OK', content: { 'application/json': { schema: envelope(op.response) } } },
        400: errorResponse,
        429: errorResponse,
      },
    }
  }
  cached = {
    openapi: '3.1.0',
    info: { title: 'TechSync CRM API', version: '0.1.0' },
    servers: [{ url: '/api' }],
    paths,
  }
  return cached
}
