import { defineTool, validateArgs } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { toParameterSchema } from '../index.js'
import { TOOL_DEFINITIONS, findToolDefinition } from '../tools.js'

/**
 * The dsh parameter DSL is not raw JSON Schema: object nodes need an explicit
 * boolean `additionalProperties`, arrays carry `items`, and requiredness is a
 * per-property `required: true`. These tests pin the projection, because a node
 * that keeps the JSON Schema shape makes the compiler reject the whole tool.
 */

function parameterSpec(name) {
  return toParameterSchema(findToolDefinition(name).inputSchema)
}

/** Every node of one converted parameter map, with its path for messages. */
function collectNodes(spec) {
  const nodes = []
  const visit = (node, path) => {
    if (node === undefined || typeof node !== 'object') return
    nodes.push({ node, path })
    if (node.items !== undefined) visit(node.items, `${path}.items`)
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      visit(child, `${path}.properties.${key}`)
    }
  }
  for (const [key, property] of Object.entries(spec)) visit(property, key)
  return nodes
}

const OPEN_PAYLOAD = {
  op: 'open',
  target: 'prod-app',
  intent: '把 app 恢复到新库并比对行数',
  steps: [
    {
      intent: '检查实例',
      action: { command: 'inspect', args: ['--dsn', 'postgres://u@h/db'] },
    },
    {
      intent: '恢复到新库',
      action: {
        command: 'restore',
        args: ['--dsn', 'postgres://u@h/db', '--input', '/tmp/a.dump'],
      },
      dependsOn: [1],
      maxAttempts: 2,
    },
  ],
}

describe('toParameterSchema', () => {
  it('projects the step element schema instead of an untyped array', () => {
    const { steps } = parameterSpec('bk_goal')
    expect(steps.type).toBe('array')
    expect(steps.items.type).toBe('object')
    expect(steps.items.additionalProperties).toBe(false)
    expect(Object.keys(steps.items.properties).sort()).toEqual([
      'action',
      'dependsOn',
      'intent',
      'maxAttempts',
    ])
    expect(steps.items.required).toBeUndefined()
    expect(steps.items.properties.intent).toEqual({
      type: 'string',
      description: '该步为什么存在',
      required: true,
    })
    expect(steps.items.properties.action.required).toBe(true)

    const { action } = steps.items.properties
    expect(action.type).toBe('object')
    expect(action.additionalProperties).toBe(false)
    expect(action.items).toBeUndefined()
    // `action` is a required property of the step; the rule that forbids
    // `required` applies to the items node itself, asserted above.
    expect(action.required).toBe(true)
    expect(action.properties.command.type).toBe('string')
    expect(action.properties.command.required).toBe(true)
    expect(action.properties.command.enum).toHaveLength(19)
    expect(action.properties.command.enum).toContain('inspect')
    expect(action.properties.args.type).toBe('array')
    expect(action.properties.args.items.type).toBe('string')
    expect(action.properties.args.required).toBe(true)

    expect(steps.items.properties.dependsOn.items.type).toBe('integer')
    expect(steps.items.properties.maxAttempts.type).toBe('integer')
  })

  it('emits no required array and declares openness on every object node', () => {
    for (const definition of TOOL_DEFINITIONS) {
      for (const { node, path } of collectNodes(
        toParameterSchema(definition.inputSchema),
      )) {
        expect(
          Array.isArray(node.required),
          `${definition.name}:${path}.required must be per-property, not an array`,
        ).toBe(false)
        if (node.type === 'object') {
          expect(
            typeof node.additionalProperties,
            `${definition.name}:${path} must declare additionalProperties`,
          ).toBe('boolean')
        }
      }
    }
  })

  it('keeps a flat tool schema unchanged', () => {
    // The eight pre-goal tools have no items or nested properties; only the
    // existing additionalProperties forwarding may differ, so pin them exactly.
    expect(parameterSpec('pg_inspect')).toEqual({
      dsn: { type: 'string', description: 'postgres:// URI', required: true },
    })
    expect(Object.keys(parameterSpec('pg_pitr')).sort()).toEqual([
      'action',
      'dataDir',
      'db',
      'dsn',
      'log',
      'port',
      'restoreCommand',
      'resume',
      'stateDir',
      'targetLsn',
      'targetName',
      'targetTime',
      'targetXid',
      'verifySql',
    ])
    expect(parameterSpec('pg_pitr').action.enum).toEqual([
      'promote',
      'pause',
      'shutdown',
    ])
    expect(parameterSpec('pg_pitr').resume).toEqual({
      type: 'boolean',
      description: '从 stateDir 的检查点续跑',
    })
    expect(parameterSpec('pg_pitr').dsn.required).toBe(true)
    expect(parameterSpec('pg_pitr').action.required).toBeUndefined()
  })

  it('compiles every definition through the real dsh schema compiler', () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(
        () =>
          defineTool({
            name: definition.name,
            description: definition.description,
            parameters: toParameterSchema(definition.inputSchema),
            output: { schema: { type: 'string' }, render: () => [] },
            execute: async () => '',
          }),
        definition.name,
      ).not.toThrow()
    }
  })

  it('accepts a realistic goal payload through the compiled argument schema', () => {
    expect(validateArgs(parameterSpec('bk_goal'), OPEN_PAYLOAD)).toEqual([])
  })

  it('enforces the element schema rather than trusting it', () => {
    const spec = parameterSpec('bk_goal')
    const badCommand = validateArgs(spec, {
      ...OPEN_PAYLOAD,
      steps: [{ intent: 'x', action: { command: 'drop-database', args: [] } }],
    })
    expect(badCommand).toHaveLength(1)
    expect(badCommand[0]).toContain('command')

    const unknownField = validateArgs(spec, {
      ...OPEN_PAYLOAD,
      steps: [
        { intent: 'x', action: { command: 'inspect', args: [] }, bogus: true },
      ],
    })
    expect(unknownField).toHaveLength(1)
    expect(unknownField[0]).toContain('additionalProperties: false')

    const missingAction = validateArgs(spec, {
      ...OPEN_PAYLOAD,
      steps: [{ intent: 'x' }],
    })
    expect(missingAction).toHaveLength(1)
    expect(missingAction[0]).toContain('action')
  })
})
