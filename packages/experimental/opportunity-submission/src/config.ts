/** Existing business API settings and explicit defaults for local opportunity submission. @author hanzhichao7 */
import z from '@deepseek-ai/schemastery'

/** Local processing limits and credentials for existing Lingxi business APIs. */
export interface Config {
  /** Existing business API origin; omission permits local import only. */
  apiBaseUrl?: string
  /** Existing short-lived business Bearer authorization; the desktop never signs tokens or loads a signing key. */
  authorizationEnv: string
  /** Maximum local source bytes read through the configured filesystem. */
  maxFileBytes: number
  /** Maximum material rows admitted into one task. */
  maxRows: number
  /** Maximum materials sent in one recognition request. */
  batchSize: number
  /** Deadline for each enterprise request, in milliseconds. */
  requestTimeoutMs: number
  /** Maximum decoded response bytes retained per enterprise request. */
  maxResponseBytes: number
  /** Maximum complete canonical tool-result bytes returned to the model. */
  maxOutputBytes: number
  /** Maximum issues and material rows returned to the model per status call. */
  previewRows: number
  /** Amount in ten-thousand yuan used only when neither user nor service supplies one. */
  defaultAmount: number
  /** Formal purchase-mode combination used when the user supplies none. */
  defaultPurchaseMode: '4-4' | '5-5' | '6-1' | '6-2' | '7-100'
  /** Days after task creation for the default quotation deadline. */
  defaultDeadlineDays: number
}

/** Validates deployment choices before tools register; defaults remain configurable. */
export const Config: z<Config> = z.object({
  apiBaseUrl: z.string().min(1),
  authorizationEnv: z.string().role('credential-ref').default('LINGXI_AUTHORIZATION'),
  maxFileBytes: z.number().step(1).min(1).default(20971520),
  maxRows: z.number().step(1).min(1).max(1000).default(1000),
  batchSize: z.number().step(1).min(1).max(1000).default(50),
  requestTimeoutMs: z.number().step(1).min(1).default(60000),
  maxResponseBytes: z.number().step(1).min(1).default(4194304),
  maxOutputBytes: z.number().step(1).min(2048).default(32768),
  previewRows: z.number().step(1).min(1).default(10),
  defaultAmount: z.number().min(0.0001).default(1),
  defaultPurchaseMode: z.union(['4-4', '5-5', '6-1', '6-2', '7-100']).default('4-4'),
  defaultDeadlineDays: z.number().step(1).min(1).default(7),
})
