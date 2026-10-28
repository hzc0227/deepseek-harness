/** Opt-in local-file opportunity tools and skill for the standard DSH desktop. @author hanzhichao7 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { Config } from './config.ts'
import { taskDomain } from './model.ts'
import { OpportunityRuntime } from './runtime.ts'

export { Config }

/** Cordis plugin identity, independent of the expert's display name. */
export const name = 'opportunity-submission'
/** All execution uses existing DSH host capabilities and the selected filesystem policy. */
export const inject = ['tools', 'skills', 'storageDomain', 'fs', 'workingDirectory', 'userQuestions']

const formProperties = {
  contractNumber: { type: 'string', description: 'Customer master-data number explicitly supplied by the user; otherwise read from the local file.' },
  projectName: { type: 'string', description: 'Opportunity name. Omit to use file name or enterprise prefill.' },
  amount: { type: 'number', description: 'Opportunity amount in ten-thousand yuan. Omit to use enterprise prefill or configured default.' },
  purchaseMode: { type: 'string', enum: ['4-4', '5-5', '6-1', '6-2', '7-100'], description: 'Formal purchase mode; omit to use the configured default.' },
  quoteDeadline: { type: 'string', description: 'Future ISO-8601 quotation deadline with explicit timezone.' },
  brandReplaceable: { type: 'boolean', description: 'Whether alternative brands are accepted; defaults to true.' },
} as const

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: object, value: object) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/**
 * Reject calls without a session owner before reading or changing any business task.
 * @param agent - Executor-authenticated optional caller.
 * @returns The live caller; sessionless execution is unsupported.
 */
function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('Opportunity submission requires a calling DSH agent')
  return agent
}

/**
 * Register local import, progression, corrections, status, and confirmed submission with effect-owned cleanup.
 * @param ctx - Host services required by the opt-in business bundle.
 * @param config - Validated enterprise gateway, local limits, and user-authorized business defaults.
 * @returns Resolution after durable storage and the bundled skill are ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(taskDomain)
  let runtime: OpportunityRuntime
  try { runtime = new OpportunityRuntime(ctx, config, domain) }
  catch (error) { await domain.close(); throw error }
  ctx.effect(() => () => runtime.close(), 'opportunity-submission.close')
  const skillPath = new URL('../assets/opportunity-submission/SKILL.md', import.meta.url)
  const raw = await readFile(skillPath, 'utf8')
  const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
  ctx.skills.register({ name: 'opportunity-submission',
    description: '商机提报：读取本地采购清单，识别检测物料、补齐必填属性、预填商机并确认提交。',
    source: 'bundled', content,
  })
  ctx.tools.register(defineTool({
    name: 'opportunity_start',
    description: 'Import a local XLSX or UTF-8 CSV procurement file into this session’s durable opportunity task. Reads customer master data above the table; never uploads the source file. Existing unfinished tasks must be resumed, not replaced.',
    parameters: {
      path: { type: 'string', required: true, description: 'Local file path selected by the user.' },
      form: { type: 'object', additionalProperties: false, properties: formProperties },
      new_task: { type: 'boolean', description: 'Explicitly start another task only after the previous task was submitted.' },
    }, output,
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      return runtime.run(agent, exec.signal, async signal => runtime.summary(
        await runtime.start(agent, args.path, args.form ?? {}, args.new_task ?? false, signal),
      ))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'opportunity_status',
    description: 'Read this session’s durable opportunity progress, editable fields, missing information, and bounded material sample. Works after desktop restart. Read status before resuming an existing task.',
    parameters: {}, output,
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent)
      return runtime.run(agent, exec.signal, () => Promise.resolve(runtime.summary(runtime.get(agent))))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'opportunity_advance',
    description: 'Execute the current opportunity stage: detection, batch attribute filling, or form prefill. Missing attribute values remain notices and do not prevent progression or confirmation. Saves completed batches without inventing values. Uncertain submissions remain blocked; never submits automatically.',
    parameters: {}, output,
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent)
      return runtime.run(agent, exec.signal, async signal => runtime.summary(await runtime.advance(agent, signal)))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'opportunity_refill',
    description: 'One-click batch-fill unchecked or incomplete attributes with the existing recognition API. Preserve source and user values and the current stage; report remaining missing values without blocking progression. Never submits or edits the source file.',
    parameters: {}, output,
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent)
      return runtime.run(agent, exec.signal, async signal => runtime.summary(await runtime.refill(agent, signal)))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'opportunity_update',
    description: 'Save explicit user corrections to this session’s opportunity. Material edits use stable source row IDs; editing source values invalidates dependent checks. Unknown or submitted outcomes reject edits. Do not invent missing material attributes.',
    parameters: {
      form: { type: 'object', additionalProperties: false, properties: formProperties },
      materials: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, name: { type: 'string' }, brand: { type: 'string' }, model: { type: 'string' },
        unit: { type: 'string' }, quantity: { type: 'number' }, excluded: { type: 'boolean' },
        attributes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', required: true }, value: { type: 'string', required: true },
        } } },
      } } },
    }, output,
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      return runtime.run(agent, exec.signal, async () => runtime.summary(
        await runtime.update(agent, args.form ?? {}, args.materials ?? []),
      ))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'opportunity_submit',
    description: 'Open the complete six-field form on one page, using standard DSH controls, for the human to enter or select customer master data, name, amount, purchase mode, deadline, and brand replacement. Parsed values are suggestions only. The human submits the whole form to create the opportunity directly, with no second confirmation. Never answer for the human or resend uncertain submissions.',
    parameters: {}, output,
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent)
      return runtime.run(agent, exec.signal, async signal => runtime.summary(await runtime.submit(agent, signal, exec.callId)))
    },
  }))
}
