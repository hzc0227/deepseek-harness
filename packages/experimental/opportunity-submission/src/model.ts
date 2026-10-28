/** Validated durable task data; file contents and recognition output are data, never instructions. @author hanzhichao7 */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { OpportunityRowId, OpportunitySubmissionKey, OpportunityTaskId } from './types.ts'
import { hasBusinessPrecision } from './quantity.ts'

/** Each material keeps the parser's physical source-row identity across every batch. */
export const MaterialSchema = z.object({
  id: z.string().min(1).max(128).transform(value => brandString<OpportunityRowId>(value)),
  name: z.string().min(1).max(1000), brand: z.string().max(50), model: z.string().min(1).max(1000),
  unit: z.string().min(1).max(10), quantity: z.number().positive().lt(1e10).refine(hasBusinessPrecision, '采购数量最多四位小数'),
  attributes: z.record(z.string(), z.string()),
  recognizedAttributes: z.record(z.string(), z.string()).default({}),
  categoryFullName: z.string().default(''), categoryFullPath: z.string().default(''),
  normalizedBrandName: z.string().default(''), normalizedBrandCode: z.string().default(''),
  valid: z.boolean().nullable().default(null), risks: z.array(z.string()).default([]),
  missingFields: z.array(z.string()).default([]), excluded: z.boolean().default(false),
  requiredFields: z.array(z.string()).default([]),
  requiredChecked: z.boolean().default(false),
})

/** One normalized material with server recognition and user corrections. */
export type Material = z.infer<typeof MaterialSchema>

/** User-editable opportunity fields; fixed business flags are assembled at submission. */
export const FormSchema = z.object({
  contractNumber: z.string().max(64), projectName: z.string().max(100),
  amount: z.number().positive().lt(1e12).refine(hasBusinessPrecision, '商机金额最多四位小数'),
  purchaseMode: z.enum(['4-4', '5-5', '6-1', '6-2', '7-100']),
  quoteDeadline: z.iso.datetime({ offset: true }), brandReplaceable: z.boolean(),
})

/** Canonical editable form, separate from generated presentation. */
export type OpportunityForm = z.infer<typeof FormSchema>

/** A restart-safe record; uncertain submissions require business-system verification and are never automatically resent. */
export const TaskSchema = z.object({
  id: z.uuid().transform(value => brandString<OpportunityTaskId>(value)),
  sessionId: z.string().min(1), revision: z.number().int().nonnegative(),
  sourcePath: z.string(), fileName: z.string(), fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['detect', 'complete', 'prefill', 'ready', 'submitting', 'unknown', 'submitted']),
  materials: z.array(MaterialSchema).min(1), form: FormSchema,
  formOverrides: FormSchema.partial(), defaults: z.array(z.string()),
  submissionKey: z.uuid().transform(value => brandString<OpportunitySubmissionKey>(value)),
  oppoCode: z.string().max(128).optional(),
})

/** Persisted work owned by one DSH session. */
export type OpportunityTask = z.infer<typeof TaskSchema>

/** Authoritative task records use DSH storage validation and durable-before-visible writes. */
export const taskDomain = defineDomain({
  name: 'opportunity_submission', version: 1,
  tables: { tasks: domainTable<SessionId, OpportunityTask>(TaskSchema) },
})

/** Business failure with a safe user-facing explanation, without transport credentials or raw responses. */
export class OpportunityError extends Error {
  /**
   * Preserve an actionable business code for callers without parsing prose.
   * @param code - Stable classification for local state, validation, or enterprise access failures.
   * @param message - Safe explanation and next action suitable for the standard DSH tool result.
   */
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`) }
}
