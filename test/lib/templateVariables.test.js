import { describe, it, expect } from 'vitest'
import { references, variableDefinitions, renderVariables, systemVariables, variableValue } from '../../src/lib/templateVariables.js'

const definition = (values = {}) => ({ key: 'meeting_link', label: 'Meeting link', type: 'url', required: true, helpText: 'Recipient booking link', placeholder: 'https://example.com', position: 0, rules: {}, ...values })
const render = (subject, body, defs = [], context = {}, values = {}) => renderVariables(subject, body, [...systemVariables(), ...defs.map((d) => ({ ...d, source: 'template' }))], context, values)

describe('template variable definitions and rendering', () => {
  it('normalizes keys and rejects duplicates, collisions, unsafe rules and invalid defaults', () => {
    expect(variableDefinitions.parse([definition({ key: ' Meeting Link ' })])[0].key).toBe('meeting_link')
    for (const defs of [[definition(), definition({ key: 'Meeting-Link' })], [definition({ key: 'user' })], [definition({ key: 'constructor' })], [definition({ key: 'workspace' })], [definition({ key: '123_key' })], [definition({ rules: { min: 1 } })], [definition({ defaultValue: 'javascript:alert(1)' })], [definition({ type: 'number', rules: { min: 5, max: 2 } })]]) expect(variableDefinitions.safeParse(defs).success).toBe(false)
  })
  it('parses supported syntax and rejects malformed, nested and arbitrary property paths', () => {
    expect(references('Hi {{ lead.first_name }} / {{meeting_link}} / {{lead.custom.industry}}').keys).toEqual(['lead.first_name', 'meeting_link', 'lead.custom.industry'])
    for (const value of ['{{name}', '{{}}', '{{ lead..email }}', '{{user[password]}}', '{{lead.__proto__.name}}', '{{first{{name}}']) expect(references(value).errors.length).toBeGreaterThan(0)
    expect(references('{{'.repeat(50000)).errors.length).toBeGreaterThan(0)
    expect(render('{{user.password}}', '<p>Hi</p>').valid).toBe(false)
  })
  it('resolves system and legacy aliases without traversing context properties', () => {
    const result = render('Hello {{lead.first_name}}', '<p>{{firstName}} from {{user.name}} at {{workspace.name}}</p>', [], { 'lead.first_name': 'Asha', firstName: 'Asha', 'user.name': 'Priya', 'workspace.name': 'CRM' })
    expect(result.subject).toBe('Hello Asha'); expect(result.bodyHtml).toBe('<p>Asha from Priya at CRM</p>'); expect(result.valid).toBe(true)
    expect(render('{{lead.password}}', 'Hi', [], { 'lead.password': 'secret' }).valid).toBe(false)
  })
  it('requires missing values, applies defaults and renders optional blanks consistently', () => {
    const defs = [definition(), definition({ key: 'project_name', label: 'Project', type: 'text', defaultValue: 'CRM rollout' }), definition({ key: 'discount', label: 'Discount', type: 'text', required: false })]
    const missing = render('{{project_name}}', '<a href="{{meeting_link}}">Meet</a>{{discount}}', defs)
    expect(missing.valid).toBe(false); expect(missing.errors.meeting_link).toContain('required'); expect(missing.subject).toBe('CRM rollout')
    const ready = render('{{project_name}}', '<a href="{{meeting_link}}">Meet</a>{{discount}}', defs, {}, { meeting_link: 'https://example.com/book?a=1&b=2' })
    expect(ready.valid).toBe(true); expect(ready.bodyHtml).toBe('<a href="https://example.com/book?a=1&amp;b=2">Meet</a>'); expect(ready.fields).toHaveLength(3)
  })
  it('validates numbers, text lengths, dates, URLs, email and Yes/No, including zero and false', () => {
    const cases = [
      [definition({ type: 'number', rules: { min: 0, max: 20 } }), 0, true], [definition({ type: 'number', rules: { max: 20 } }), '21', false],
      [definition({ type: 'number' }), 'not a number', false], [definition({ type: 'checkbox' }), false, true], [definition({ type: 'checkbox' }), 'maybe', false],
      [definition({ type: 'date' }), '2026-02-30', false], [definition({ type: 'date' }), '2028-02-29', true],
      [definition({ type: 'email' }), 'invalid', false], [definition({ type: 'email' }), 'a@example.com', true],
      [definition(), 'https://user:secret@example.com', false], [definition(), 'javascript:alert(1)', false],
      [definition({ type: 'text', rules: { minLength: 3, maxLength: 5 } }), 'ab', false], [definition({ type: 'text', rules: { maxLength: 5 } }), 'abcdef', false],
    ]
    for (const [def, value, valid] of cases) expect(!variableValue(def, value).error, String(value)).toBe(valid)
  })
  it('escapes HTML values once, blocks header injection and never recursively substitutes input', () => {
    const def = definition({ key: 'project_name', label: 'Project', type: 'textarea' })
    const result = render('Hi', '<strong>{{project_name}}</strong>', [def], {}, { project_name: '<img src=x onerror=alert(1)> " & <script>x</script>' })
    expect(result.valid).toBe(true); expect(result.bodyHtml).toContain('&lt;img'); expect(result.bodyHtml).not.toContain('<script>')
    expect(render('{{project_name}}', 'Hi', [def], {}, { project_name: 'Hi\r\nBcc: bad@example.com' }).valid).toBe(false)
    expect(render('Hi', '{{project_name}}', [def], {}, { project_name: '{{user.name}}' }).valid).toBe(false)
    expect(render('{{name}}', 'Hi', [], { name: '{{user.name}}', 'user.name': 'Secret' }).valid).toBe(false)
  })
  it('ignores overrides for live CRM values and does not require unused variables', () => {
    const result = render('{{lead.first_name}}', '<p>Hello</p>', [definition()], { 'lead.first_name': 'Real recipient' }, { 'lead.first_name': 'Spoofed recipient' })
    expect(result.subject).toBe('Real recipient'); expect(result.valid).toBe(true); expect(result.fields).toEqual([])
    const long = render('Hello', `<p>${'hello '.repeat(15000)}{{name}}</p>`, [], { name: 'Asha' })
    expect(long.valid).toBe(true); expect(long.bodyHtml.endsWith('Asha</p>')).toBe(true)
  })
})
