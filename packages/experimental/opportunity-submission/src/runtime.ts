/** Five-stage business execution over local durable tasks and authenticated enterprise operations. @author hanzhichao7 */
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { AskUserQuestionItem, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { Config } from './config.ts'
import { BusinessGateway } from './gateway.ts'
import { FormSchema, MaterialSchema, OpportunityError, TaskSchema, taskDomain } from './model.ts'
import type { Material, OpportunityForm, OpportunityTask } from './model.ts'
import { parseMaterialFile } from './parse.ts'
import type { OpportunitySubmissionKey, OpportunityTaskId } from './types.ts'

const optionalText = z.string().nullish().transform(value => value ?? '')
const optionalTexts = z.array(z.string()).nullish().transform(value => value ?? [])
const categoryResult = z.object({
  itemId: z.string(), normalizedBrandName: optionalText, normalizedBrandCode: optionalText,
  categoryFullName: optionalText, categoryFullPath: optionalText,
})
const invalidResult = z.object({
  itemId: z.string(), isInvalidOppo: z.union([z.literal(0), z.literal(1)]),
  isNonSupplies: z.union([z.literal(0), z.literal(1)]).nullish(), haveRiskVenderName: z.union([z.literal(0), z.literal(1)]).nullish(),
  invalidOppoTags: z.record(z.string(), z.string()).nullish(),
  baseInvalidCheckResult: optionalTexts, riskVenderNameList: optionalTexts,
})
const attributeResult = z.object({
  indexCode: z.string(), requiredFieldKeys: optionalTexts, success: z.boolean(),
  attributeValues: z.record(z.string(), z.string()).nullish().transform(value => value ?? {}),
  missingFields: optionalTexts, failReason: optionalText,
})
const prefillResult = z.object({
  projectName: z.string().nullish(), opportunityAmount: z.union([z.number(), z.string()]).nullish(),
  customerActualQuoteDeadline: z.string().nullish(),
}).loose()

/** A user correction targets an existing physical source row, never an array position. */
export interface MaterialPatch {
  id: string
  name?: string
  brand?: string
  model?: string
  unit?: string
  quantity?: number
  excluded?: boolean
  /** Confirmed attribute values; unrelated source fields remain unchanged. */
  attributes?: { name: string; value: string }[]
}

/** Local authoritative state with one operation per session and durable submission uncertainty. */
export class OpportunityRuntime {
  private readonly busy = new Set<SessionId>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private readonly gateway: BusinessGateway

  /**
   * Bind a plugin-owned domain and host facilities; the plugin must await close before storage disposal.
   * @param ctx - DSH filesystem, credential, question, and working-directory facilities.
   * @param config - Validated deployment limits and business defaults.
   * @param domain - Exclusive open handle for this plugin's authoritative tasks.
   */
  constructor(private readonly ctx: Context, private readonly config: Config, private readonly domain: Domain<typeof taskDomain>) {
    this.gateway = new BusinessGateway(ctx, config)
  }

  /**
   * Stop new operations, cancel in-flight HTTP and questions, then release durable storage.
   * @returns Resolution after every owned operation and domain close have settled.
   */
  async close(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending])
    await this.domain.close()
  }

  /**
   * Fence each session against concurrent mutations and combine caller cancellation with plugin teardown.
   * @param agent - Live calling agent; its session is the only permitted task owner.
   * @param signal - Tool invocation cancellation.
   * @param action - Operation executed while this session's exclusive slot is held.
   * @returns The operation result; a concurrent invocation is rejected without changing state.
   */
  async run<T>(agent: Agent, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    if (this.busy.has(agent.session.id)) throw new OpportunityError('TASK_BUSY', '当前商机任务正在处理，请等待本次操作完成。')
    this.busy.add(agent.session.id)
    const operation = Promise.resolve().then(() => action(combined))
    this.pending.add(operation)
    try { return await operation }
    finally { this.pending.delete(operation); this.busy.delete(agent.session.id) }
  }

  /**
   * Import local bytes through DSH file policy, extracting customer identity only from source data or user input.
   * @param agent - Owner of the new task and source-file execution policy.
   * @param path - Local source path, resolved against this session's working directory.
   * @param form - Explicit user values, which outrank defaults and later prefill suggestions.
   * @param newTask - Explicit replacement of a completed task; unresolved submissions can never be replaced.
   * @param signal - Abortable file read and parser admission.
   * @returns The durable imported task, ready for detection.
   */
  async start(agent: Agent, path: string, form: Partial<OpportunityForm>, newTask: boolean, signal: AbortSignal): Promise<OpportunityTask> {
    const previous = this.domain.table('tasks').get(agent.session.id)
    if (previous !== undefined && (!newTask || previous.phase !== 'submitted')) {
      throw new OpportunityError('TASK_EXISTS', '此会话已有商机任务，请先查看并继续；仅已完成任务允许明确新建。')
    }
    const target = await this.ctx.fs.resolve(path, { cwd: this.ctx.workingDirectory.get(agent.session), signal })
    const bytes = await this.ctx.fs.readBytes(target, signal, this.config.maxFileBytes)
    signal.throwIfAborted()
    const fileName = basename(target.displayPath)
    const parsed = await parseMaterialFile(bytes, fileName, this.config.maxRows)
    signal.throwIfAborted()
    const initial = FormSchema.parse({
      contractNumber: parsed.contractNumber ?? '', projectName: basename(fileName, extname(fileName)).slice(0, 100),
      amount: this.config.defaultAmount, purchaseMode: this.config.defaultPurchaseMode,
      quoteDeadline: new Date(Date.now() + this.config.defaultDeadlineDays * 86400000).toISOString(),
      brandReplaceable: true, ...form,
    })
    const task: OpportunityTask = {
      id: brandString<OpportunityTaskId>(randomUUID()), sessionId: agent.session.id, revision: 0,
      sourcePath: target.displayPath, fileName, fileHash: createHash('sha256').update(bytes).digest('hex'),
      phase: 'detect', materials: parsed.materials.map(row => MaterialSchema.parse(row)),
      form: initial, formOverrides: form,
      defaults: ['projectName', 'amount', 'purchaseMode', 'quoteDeadline', 'brandReplaceable'].filter(key => !(key in form)),
      submissionKey: brandString<OpportunitySubmissionKey>(randomUUID()),
    }
    return this.save(agent.session.id, task)
  }

  /**
   * Read only the calling session's task; no tool parameter can select another session's data.
   * @param agent - Task owner authenticated by the DSH tool executor.
   * @returns The immutable durable task or an actionable missing-task failure.
   */
  get(agent: Agent): OpportunityTask {
    const task = this.domain.table('tasks').get(agent.session.id)
    if (task === undefined) throw new OpportunityError('NO_TASK', '请先提供本地采购文件并创建商机提报任务。')
    return task
  }

  /**
   * Apply user corrections and invalidate only dependent recognition/confirmation work.
   * @param agent - Task owner.
   * @param form - Explicit editable form changes, including an intentional empty customer number.
   * @param patches - Existing source rows and confirmed replacement values.
   * @returns The durable revised task; submitted or uncertain tasks reject edits.
   */
  async update(agent: Agent, form: Partial<OpportunityForm>, patches: readonly MaterialPatch[]): Promise<OpportunityTask> {
    const task = this.get(agent)
    if (['submitting', 'unknown', 'submitted'].includes(task.phase)) throw new OpportunityError('TASK_LOCKED', '提交中、结果待核实或已提交的任务不能修改，请先核实提交结果。')
    const indexed = new Map(patches.map(patch => [patch.id, patch]))
    if (indexed.size !== patches.length || patches.some(patch => !task.materials.some(row => row.id === patch.id))) {
      throw new OpportunityError('ROW_MISMATCH', '修正包含重复或不存在的物料行，请按当前任务的行标识提交。')
    }
    const coreFields = ['name', 'brand', 'model', 'unit', 'quantity'] as const
    const detectionAttributes = new Set(['包规', '目标价', '物料编号', '备注1', '备注2', '备注3', '品牌是否可替换'])
    const changesDetection = (patch: MaterialPatch) => coreFields.some(key => key in patch)
      || (patch.attributes ?? []).some(attribute => detectionAttributes.has(attribute.name))
    const globalDetectionChanged = form.brandReplaceable !== undefined && form.brandReplaceable !== task.form.brandReplaceable
    const redetect = globalDetectionChanged || patches.some(patch => changesDetection(patch))
    const materials = task.materials.map((row) => {
      const patch = indexed.get(row.id)
      if (patch === undefined && !globalDetectionChanged) return row
      const { attributes, ...fields } = patch ?? {}
      const coreChanged = globalDetectionChanged || patch !== undefined && changesDetection(patch)
      const merged = Object.fromEntries<string>([
        ...Object.entries(row.attributes), ...(attributes ?? []).map(item => [item.name, item.value] as const),
      ])
      const known = { ...row.recognizedAttributes, ...merged }
      const missingFields = row.requiredFields.filter(key => !meaningful(attributeValue(row, known, key)))
      return MaterialSchema.parse({ ...row, ...fields, attributes: merged, missingFields,
        ...(coreChanged ? { valid: null, requiredChecked: false, recognizedAttributes: {}, requiredFields: [], missingFields: [], categoryFullName: '', categoryFullPath: '', normalizedBrandName: '', normalizedBrandCode: '' } : {}),
      })
    })
    return this.save(agent.session.id, { ...task, materials, form: FormSchema.parse({ ...task.form, ...form }),
      formOverrides: { ...task.formOverrides, ...form }, phase: redetect ? 'detect'
        : task.phase !== 'detect' && materials.some(row => row.valid === true && !row.excluded && !row.requiredChecked) ? 'complete' : task.phase,
    })
  }

  /**
   * Execute the current business stage, preserving each completed read-only batch before the next request.
   * @param agent - Calling session owner.
   * @param signal - Cancellation for enterprise calls.
   * @returns The next durable stage or the same stage with unresolved business information.
   */
  async advance(agent: Agent, signal: AbortSignal): Promise<OpportunityTask> {
    const task = this.get(agent)
    switch (task.phase) {
      case 'detect': return this.detect(agent, task, signal)
      case 'complete': return this.save(agent.session.id, { ...await this.fillAttributes(agent, task, signal), phase: 'prefill' })
      case 'prefill': return this.prefill(agent, task, signal)
      case 'ready': return task
      case 'submitting':
      case 'unknown': return task
      case 'submitted': return task
    }
  }

  /**
   * Batch-fill unchecked or incomplete materials without changing the current business stage.
   * @param agent - Session owner requesting one-click attribute filling.
   * @param signal - Cancellation for recognition; completed batches remain durable.
   * @returns Updated real values and remaining missing-field notices; no submission occurs.
   */
  async refill(agent: Agent, signal: AbortSignal): Promise<OpportunityTask> {
    const task = this.get(agent)
    if (['submitting', 'unknown', 'submitted'].includes(task.phase)) throw new OpportunityError('TASK_LOCKED', '提交中、结果待核实或已提交的任务不能修改，请先核实提交结果。')
    if (task.phase === 'detect') throw new OpportunityError('NOT_READY', '请先完成物料检测后再执行一键回填。')
    return this.fillAttributes(agent, task, signal, true)
  }

  /**
   * Collect the final editable form through standard DSH input and submit its human-supplied values once.
   * @param agent - Root agent permitted to open a human question.
   * @param signal - Cancellation; once HTTP may have started, every failure retains an unknown outcome.
   * @param callId - Logged invocation identity used to keep the form draft and reopen its panel.
   * @returns Submitted task, unchanged task after cancellation, or explicit uncertainty; no second confirmation is requested.
   */
  async submit(agent: Agent, signal: AbortSignal, callId: ToolCallId): Promise<OpportunityTask> {
    const task = this.get(agent)
    if (task.phase === 'submitted') return task
    if (task.phase === 'submitting' || task.phase === 'unknown') return task
    if (task.phase !== 'ready') throw new OpportunityError('NOT_READY', '请先完成物料检测、属性识别和商机预填，再填写提交表单。')
    await this.gateway.ensureAccess({})
    const questions = this.formQuestions(task)
    const answer = await this.ctx.userQuestions.ask({ agent, signal, questions, wait: { callId } })
    if (answer.answers.length === 0) return task
    const form = this.readForm(questions, answer)
    signal.throwIfAborted()
    if (this.get(agent).revision !== task.revision) throw new OpportunityError('STALE_CONFIRMATION', '表单对应的数据已变化，请重新填写提交表单。')
    const inputBlockers = this.blockers({ ...task, form })
    if (inputBlockers.length > 0) throw new OpportunityError('INVALID_FORM', inputBlockers.join('；'))
    let filled = await this.update(agent, form, [])
    if (filled.phase === 'detect') {
      const scope = task.materials.filter(row => row.valid === true && !row.excluded).map(row => row.id).join('\n')
      filled = await this.advance(agent, signal)
      filled = await this.advance(agent, signal)
      filled = await this.advance(agent, signal)
      if (filled.materials.filter(row => row.valid === true && !row.excluded).map(row => row.id).join('\n') !== scope) {
        throw new OpportunityError('SCOPE_CHANGED', '品牌替代要求改变了有效物料范围，请查看新结果后重新填写提交表单。')
      }
    }
    const blockers = this.blockers(filled)
    if (blockers.length > 0) throw new OpportunityError('INVALID_FORM', blockers.join('；'))
    filled = await this.save(agent.session.id, { ...filled, defaults: [] })
    const payload = this.payload(filled)
    await this.gateway.ensureAccess(payload)
    const pending = await this.save(agent.session.id, { ...filled, phase: 'submitting' })
    try {
      const oppoCode = await this.gateway.post('submit', payload, z.string().trim().min(1).max(128), signal)
      return await this.save(agent.session.id, { ...pending, phase: 'submitted', oppoCode })
    } catch (_error) {
      await this.save(agent.session.id, { ...pending, phase: 'unknown' })
      throw new OpportunityError('SUBMISSION_UNKNOWN', '本次提交结果待核实，已禁止重复提交。请在业务系统核实结果；不要新建相同任务再次提报。')
    }
  }

  /**
   * Offer six editable fields as one standard DSH question form; suggestions require explicit user selection or replacement.
   * @param task - Current prefill values and material notices shown before the user submits the form.
   * @returns Stable revision-bound field questions; the form's submit action authorizes the business request.
   */
  private formQuestions(task: OpportunityTask): AskUserQuestionItem[] {
    const fields: { key: keyof OpportunityForm; label: string; hint: string; options?: { label: string; description?: string }[] }[] = [
      { key: 'contractNumber', label: '客户主数据号', hint: '填写客户主数据号，或选择文件解析出的建议值。' },
      { key: 'projectName', label: '商机名称', hint: '填写商机名称，最多100个字符。' },
      { key: 'amount', label: '商机金额', hint: '填写大于0的金额，单位为万元，最多四位小数。' },
      { key: 'purchaseMode', label: '采购模式', hint: '选择本次商机的采购模式。', options: [
        { label: '4-4', description: '商城数字化-商城静默' }, { label: '5-5', description: '商城数字化-商城比价' },
        { label: '6-1', description: 'SRM数字化-SRM询比价' }, { label: '6-2', description: 'SRM数字化-SRM竞比投' },
        { label: '7-100', description: '招投标数字化' },
      ] },
      { key: 'quoteDeadline', label: '报价截止时间', hint: '填写含时区的未来时间，例如 2026-10-29T18:00:00+08:00。' },
      { key: 'brandReplaceable', label: '品牌替代要求', hint: '选择是否允许替代品牌。填写全部字段后点击“提交”，将直接创建商机。',
        options: [{ label: '允许替代品牌' }, { label: '不允许替代品牌' }] },
    ]
    return fields.map((field, index) => {
      const suggested = field.key === 'brandReplaceable'
        ? task.form.brandReplaceable ? '允许替代品牌' : '不允许替代品牌' : String(task.form[field.key])
      return {
        id: `opportunity-form-${task.revision}-${field.key}`, header: field.label, question: field.hint,
        ...(index === 0 ? { detail: this.confirmation(task) } : {}),
        options: field.options === undefined ? [{ label: suggested, description: '预填建议，可选择或在其他输入中填写新值。' }]
          : [...field.options.filter(option => option.label === suggested), ...field.options.filter(option => option.label !== suggested)],
      }
    })
  }

  /**
   * Validate every human field independently of model arguments; skipped, duplicate, or ambiguous answers never submit.
   * @param questions - Exact field ids offered for this task revision.
   * @param answer - Untrusted structured response from the input UI.
   * @returns The complete form supplied by the human, without silently restoring defaults.
   */
  private readForm(questions: AskUserQuestionItem[], answer: AskUserQuestionAnswer): OpportunityForm {
    const indexed = new Map(answer.answers.map(item => [item.id, item]))
    if (indexed.size !== questions.length || answer.answers.length !== questions.length) {
      throw new OpportunityError('INVALID_FORM', '请填写全部六个表单字段后提交。')
    }
    const values = questions.map((question) => {
      const item = indexed.get(question.id)
      if (item === undefined || item.custom !== undefined && item.selected.length > 0
        || item.custom === undefined && item.selected.length !== 1) {
        throw new OpportunityError('INVALID_FORM', `请填写${question.header}，不要跳过或同时提供多个值。`)
      }
      const value = (item.custom ?? item.selected[0] ?? '').trim()
      if (!value) throw new OpportunityError('INVALID_FORM', `请填写${question.header}。`)
      return value
    })
    const [contractNumber, projectName, amount, purchaseMode, quoteDeadline, brand] = values
    if (!/^(?:[0-9]+(?:\.[0-9]{1,4})?|\.[0-9]{1,4})$/u.test(amount ?? '')) {
      throw new OpportunityError('INVALID_FORM', '金额请填写最多四位小数的十进制数，单位为万元。')
    }
    if (!['允许替代品牌', '不允许替代品牌'].includes(brand ?? '')) throw new OpportunityError('INVALID_FORM', '请选择品牌替代要求。')
    const parsed = FormSchema.safeParse({ contractNumber, projectName, amount: Number(amount), purchaseMode, quoteDeadline,
      brandReplaceable: brand === '允许替代品牌' })
    if (!parsed.success) throw new OpportunityError('INVALID_FORM', '表单数据无效，请核对金额、采购模式、名称长度和报价截止时间格式。')
    return parsed.data
  }

  /**
   * Produce bounded task facts for standard tool output, without copying the complete material dataset into model context.
   * @param task - Durable task snapshot.
   * @returns Task progress, editable form, bounded issues and material samples.
   */
  summary(task: OpportunityTask) {
    const blockers = this.blockers(task)
    const issues = [...blockers, ...this.attributeIssues(task)]
    const result = { taskId: task.id, phase: task.phase, revision: task.revision, total: task.materials.length,
      valid: task.materials.filter(row => row.valid === true && !row.excluded).length,
      excluded: task.materials.filter(row => row.valid === false || row.excluded).length,
      form: task.form, defaults: task.defaults, blockingIssueCount: blockers.length, issueCount: issues.length,
      issues: issues.slice(0, this.config.previewRows).map(issue => issue.slice(0, 512)),
      materials: task.materials.slice(0, this.config.previewRows).map(row => ({
        id: row.id, name: row.name.slice(0, 256), unit: row.unit.slice(0, 64),
        quantity: row.quantity, valid: row.valid, excluded: row.excluded,
        missingFields: row.missingFields.slice(0, this.config.previewRows).map(key => key.slice(0, 128)),
        risks: row.risks.slice(0, this.config.previewRows).map(risk => risk.slice(0, 256)),
      })),
      ...(task.oppoCode === undefined ? {} : { oppoCode: task.oppoCode }),
    }
    while (Buffer.byteLength(JSON.stringify(result)) > this.config.maxOutputBytes) {
      if (result.materials.length > 0) result.materials.pop()
      else if (result.issues.length > 0) result.issues.pop()
      else throw new OpportunityError('OUTPUT_TOO_LARGE', '商机状态超出展示上限，请调整输出限额。')
    }
    return result
  }

  /**
   * Persist one validated revision before exposing progress or proceeding with another side effect.
   * @param owner - Session whose exclusive operation slot is held by the caller.
   * @param task - Replacement record; existing stored objects are never mutated in place.
   * @returns The committed revision; storage failure leaves the preceding record authoritative.
   */
  private async save(owner: SessionId, task: OpportunityTask): Promise<OpportunityTask> {
    const next = TaskSchema.parse({ ...task, revision: task.revision + 1 })
    await this.domain.table('tasks').put(owner, next)
    return next
  }

  /**
   * Map category/brand and validity by complete stable-ID sets, persisting each completed batch independently.
   * @param agent - Task owner holding the session operation slot.
   * @param original - Durable record from which unfinished detection resumes.
   * @param signal - Cancellation for both read-only enterprise calls in each batch.
   * @returns The completion stage; a failed batch leaves earlier committed batches available for resumption.
   */
  private async detect(agent: Agent, original: OpportunityTask, signal: AbortSignal): Promise<OpportunityTask> {
    let task = original
    const candidates = task.materials.filter(row => row.valid === null)
    for (let offset = 0; offset < candidates.length; offset += this.config.batchSize) {
      const batch = candidates.slice(offset, offset + this.config.batchSize)
      const categories = await this.gateway.post('category-brand', { itemList: batch.map(row => ({
        itemId: row.id, demandSkuName: row.name, demandModel: row.model, demandBrandName: row.brand,
      })) }, z.array(categoryResult), signal)
      const categoryMap = exactResults(batch, categories, item => item.itemId)
      const enriched = batch.map(row => ({ ...row, ...categoryMap(row.id) }))
      const validity = await this.gateway.post('invalid-check', {
        itemList: enriched.map(row => invalidMaterial(row, task.form.brandReplaceable)),
      }, z.array(invalidResult), signal)
      const invalidMap = exactResults(batch, validity, item => item.itemId)
      const changed = new Map(enriched.map((row) => {
        const result = invalidMap(row.id)
        // isInvalidOppo is the required aggregate verdict; supplementary flags may be absent in existing deployments.
        return [row.id, { ...row, valid: result.isInvalidOppo === 0 && result.isNonSupplies !== 1,
          risks: [...Object.values(result.invalidOppoTags ?? {}), ...result.baseInvalidCheckResult, ...result.riskVenderNameList, ...(result.haveRiskVenderName === 1 ? ['存在风险供应商'] : [])],
        }]
      }))
      task = await this.save(agent.session.id, { ...task, materials: task.materials.map(row => changed.get(row.id) ?? row) })
    }
    return this.save(agent.session.id, { ...task, phase: 'complete' })
  }

  /**
   * Request category-specific requirements and retain recognized real values without overwriting source or user facts.
   * @param agent - Task owner holding the session operation slot.
   * @param original - Durable detection output and any confirmed user corrections.
   * @param signal - Cancellation for read-only attribute recognition.
   * @param includeMissing - Explicit one-click filling also retries already checked rows with unresolved values.
   * @returns The same business stage with recognized values and unresolved notices; missing values do not block progression.
   */
  private async fillAttributes(
    agent: Agent, original: OpportunityTask, signal: AbortSignal, includeMissing = false,
  ): Promise<OpportunityTask> {
    let task = original
    const candidates = task.materials.filter(row => row.valid === true && !row.excluded
      && (!row.requiredChecked || includeMissing && row.missingFields.length > 0))
    for (let offset = 0; offset < candidates.length; offset += this.config.batchSize) {
      const batch = candidates.slice(offset, offset + this.config.batchSize)
      const results = await this.gateway.post('attributes', batch.map(row => attributeMaterial(row)), z.array(attributeResult), signal)
      const indexed = exactResults(batch, results, item => item.indexCode)
      const changed = new Map(batch.map((row) => {
        const result = indexed(row.id)
        if (result.failReason.trim()) throw new OpportunityError('RECOGNITION_FAILED', `${row.id} 属性识别未完成，请核实物料信息后继续。`)
        const found = Object.entries(result.attributeValues).filter(([, value]) => meaningful(value))
        const recognizedAttributes = { ...row.recognizedAttributes, ...Object.fromEntries<string>(found) }
        const attributes = { ...recognizedAttributes, ...row.attributes }
        const requiredFields = [...new Set([...row.requiredFields, ...result.requiredFieldKeys, ...result.missingFields])]
        const missingFields = requiredFields.filter(key => !meaningful(attributeValue(row, attributes, key)))
        if (!result.success && missingFields.length === 0) throw new OpportunityError('RECOGNITION_FAILED', `${row.id} 未获得明确的属性识别结果，请核实企业服务。`)
        return [row.id, {
          ...row, recognizedAttributes, requiredFields, missingFields, requiredChecked: true,
        }]
      }))
      task = await this.save(agent.session.id, { ...task, materials: task.materials.map(row => changed.get(row.id) ?? row) })
    }
    return task
  }

  /**
   * Apply enterprise suggestions once while preserving source identity, explicit user values, and chosen defaults.
   * @param agent - Task owner holding the session operation slot.
   * @param task - Validated material task; actual SKU references may be absent.
   * @param signal - Cancellation for the read-only prefill request.
   * @returns The committed ready form, retaining local defaults wherever the service supplied no usable value.
   */
  private async prefill(agent: Agent, task: OpportunityTask, signal: AbortSignal): Promise<OpportunityTask> {
    const materials = task.materials.filter(row => row.valid === true && !row.excluded)
      .flatMap(row => meaningful(row.attributes.skuId) ? [{ skuId: row.attributes.skuId }] : [])
    const data = await this.gateway.post('prefill', {
      fileName: task.fileName, materials, sourceRevision: task.fileHash,
    }, prefillResult, signal)
    const amount = data.opportunityAmount === null || data.opportunityAmount === undefined ? undefined : Number(data.opportunityAmount)
    const form = FormSchema.parse({ ...task.form,
      ...(meaningful(data.projectName) ? { projectName: data.projectName } : {}),
      ...(amount !== undefined && Number.isFinite(amount) && amount > 0 ? { amount } : {}),
      ...(typeof data.customerActualQuoteDeadline === 'string' && z.iso.datetime({ offset: true }).safeParse(data.customerActualQuoteDeadline).success && Date.parse(data.customerActualQuoteDeadline) > Date.now() ? { quoteDeadline: data.customerActualQuoteDeadline } : {}),
      ...task.formOverrides,
    })
    const supplied = new Set([
      ...(meaningful(data.projectName) ? ['projectName'] : []),
      ...(amount !== undefined && Number.isFinite(amount) && amount > 0 ? ['amount'] : []),
      ...(form.quoteDeadline !== task.form.quoteDeadline ? ['quoteDeadline'] : []),
    ])
    return this.save(agent.session.id, { ...task, phase: 'ready', form, defaults: task.defaults.filter(key => !supplied.has(key)) })
  }

  /**
   * Derive submission gate failures from persisted business facts, independently of model instructions.
   * @param task - Current canonical form and material validation results.
   * @returns Every unresolved input or incomplete check; an empty list permits the ready-stage confirmation.
   */
  private blockers(task: OpportunityTask): string[] {
    const rows = task.materials.filter(row => row.valid === true && !row.excluded)
    return [
      ...(['submitting', 'unknown'].includes(task.phase) ? ['提交结果待核实；当前接口没有可按本地任务查询的结果接口，禁止自动重提。'] : []),
      ...(!/^[A-Za-z]{3}-[0-9]{6,}$/.test(task.form.contractNumber) ? ['请补充合法的客户主数据号。'] : []),
      ...(!task.form.projectName.trim() || task.form.projectName.length > 100 ? ['商机名称不能为空且最多100个字符。'] : []),
      ...(Date.parse(task.form.quoteDeadline) <= Date.now() ? ['报价截止时间已过期，请更新。'] : []),
      ...(task.materials.some(row => row.valid === null) ? ['物料检测尚未完成。'] : []),
      ...(rows.length === 0 ? ['当前没有可以正式提报的有效物料。'] : []),
      ...rows.filter(row => !row.requiredChecked).map(row => `${row.id}：必填属性校验尚未完成。`),
    ]
  }

  /**
   * List unresolved attribute values as notices independently of submission gates.
   * @param task - Persisted materials, including their latest recognition and user corrections.
   * @returns Missing fields for valid included rows; these notices never fabricate values or exclude rows.
   */
  private attributeIssues(task: OpportunityTask): string[] {
    return task.materials.filter(row => row.valid === true && !row.excluded)
      .flatMap(row => row.missingFields.map(key => `${row.id} ${row.name}：缺少${key}`))
  }

  /**
   * Render the frozen revision into the standard DSH question's supporting detail.
   * @param task - Revision whose operation slot remains held throughout the human decision.
   * @returns The exact submitted scope and reviewable defaults, without credentials or complete raw source rows.
   */
  private confirmation(task: OpportunityTask): string {
    return [`商机名称：${task.form.projectName}`, `客户主数据号：${task.form.contractNumber}`,
      `金额：${task.form.amount} 万元`, `采购模式：${task.form.purchaseMode}`, `报价截止：${task.form.quoteDeadline}`,
      `物料：${task.materials.length} 条，提交 ${task.materials.filter(row => row.valid === true && !row.excluded).length} 条`,
      `未回填字段（不阻塞流程）：${this.attributeIssues(task).join('；') || '无'}`].join('\n')
  }

  /**
   * Assemble the local-file source and explicit domestic industrial opportunity fields.
   * @param task - Ready canonical record; only valid, included materials and required attributes are projected.
   * @returns The existing direct-submit request with content-addressed local origin and the actual durable material collection.
   */
  private payload(task: OpportunityTask): object {
    const [firstPurchaseModel, secondPurchaseModel] = task.form.purchaseMode.split('-')
    return {
      // The existing API only validates these trace fields for presence and never reads an external sheet.
      // Explicit local namespaces identify real local records without claiming a JoySpace document exists.
      source: { pageId: `urn:sha256:${task.fileHash}`, sheetId: `dsh-materials:${task.id}`,
        originalFileName: task.fileName, snapshotVersion: String(task.revision) },
      opportunity: { projectName: task.form.projectName, contractNumber: task.form.contractNumber, amount: task.form.amount,
        businessType: 1, oppoCategory: 1, firstPurchaseModel, secondPurchaseModel, isBom: 0, selfBrand: 0,
        customerActualQuoteDeadline: Date.parse(task.form.quoteDeadline), projectCycleType: 4,
        decisionMethod: 2, oppoFlag: 0, quoteDimensions: 0,
        quoteRequirements: { brandReplaceable: task.form.brandReplaceable ? 1 : 0, skuState: 0, stockState: 0 },
      }, materials: task.materials.filter(row => row.valid === true && !row.excluded).map(row => ({
        sourceRowId: row.id, demandSkuName: row.name, demandBrandName: row.brand, demandModel: row.model,
        demandSaleUnit: row.unit, demandNums: row.quantity, categoryFullName: row.categoryFullName,
        categoryFullPath: row.categoryFullPath, uniBrandName: row.normalizedBrandName, uniBrandId: row.normalizedBrandCode,
        requiredAttributes: Object.fromEntries<string>(row.requiredFields.flatMap((key) => {
          const value = attributeValue(row, { ...row.recognizedAttributes, ...row.attributes }, key)
          return meaningful(value) ? [[key, value] as const] : []
        })), valid: true, risks: row.risks,
      })),
    }
  }
}

/**
 * Reject missing, extra, and duplicate recognition IDs instead of associating rows by response order.
 * @param rows - Exact requested source row set.
 * @param results - Validated remote result items.
 * @param id - Operation-specific result identity accessor.
 * @returns The complete ID index, safe for association with the request batch.
 */
function exactResults<T>(rows: readonly Material[], results: readonly T[], id: (result: T) => string): (key: string) => T {
  const indexed = new Map(results.map(result => [id(result), result]))
  if (indexed.size !== results.length || indexed.size !== rows.length || rows.some(row => !indexed.has(row.id))) {
    throw new OpportunityError('RESULT_ID_MISMATCH', '识别结果行标识缺失、重复或不属于本批次，流程已停止，未按结果顺序关联物料。')
  }
  return (key) => {
    const result = indexed.get(key)
    if (result === undefined) throw new Error('Result lookup must use a validated source row ID')
    return result
  }
}

/**
 * Recognize a real business value; unknown placeholders never satisfy required fields.
 * @param value - Untrusted suggested or user-provided scalar text.
 * @returns Whether the text expresses a nonempty value rather than an unknown marker.
 */
function meaningful(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== '' && !['无', '未知', '未识别', 'null', 'undefined'].includes(value.trim())
}

/**
 * Resolve requirements against canonical units and quantities before additional attributes.
 * @param row - Canonical source material, including validated quantity and unit.
 * @param attributes - Merged automatic suggestions and explicit source/user values.
 * @param key - Enterprise-declared required field name.
 * @returns The known own-property value, or undefined for an unresolved requirement.
 */
function attributeValue(row: Material, attributes: Record<string, string>, key: string): string | undefined {
  if (key === '单位' || key === '需求单位' || key === 'demandSaleUnit') return row.unit
  if (key === '数量' || key === '采购数量' || key === 'demandNums') return String(row.quantity)
  return Object.hasOwn(attributes, key) ? attributes[key] : undefined
}

/**
 * Project canonical values into the existing attribute-recognition request.
 * @param row - Valid material with category and brand recognition facts.
 * @returns Only declared recognition fields; the source-row identity is carried by indexCode.
 */
function attributeMaterial(row: Material) {
  return { indexCode: row.id, demandSkuName: row.name, demandBrandName: row.brand, demandModel: row.model,
    demandSaleUnit: row.unit, demandNums: row.quantity, categoryFullName: row.categoryFullName,
    categoryFullPath: row.categoryFullPath, demandPackUnit: row.attributes['包规'] ?? '',
    demandNotes: Object.entries(row.attributes).filter(([key]) => key.startsWith('备注')).map(([, value]) => value).join('；'),
  }
}

/**
 * Preserve the original detection fields rather than losing price, code, or independent notes during local normalization.
 * @param row - Canonical source row with original additional procurement columns.
 * @param brandReplaceable - Explicit task option used only when this row supplies no value.
 * @returns The existing invalid-material API fields, with quantities and target price in their wire text representation.
 */
function invalidMaterial(row: Material, brandReplaceable: boolean) {
  const original = row.attributes['品牌是否可替换']
  let replaceable = brandReplaceable ? 1 : 0
  if (original !== undefined && original.trim() !== '') {
    if (['1', '是', 'true'].includes(original.trim())) replaceable = 1
    else if (['0', '否', 'false'].includes(original.trim())) replaceable = 0
    else throw new OpportunityError('INVALID_BRAND_OPTION', `${row.id} 品牌是否可替换必须为是或否，请修正原表后重试。`)
  }
  return { itemId: row.id, demandSkuName: row.name, demandBrandName: row.brand, demandModel: row.model,
    demandSaleUnit: row.unit, demandNums: String(row.quantity), demandPackUnit: row.attributes['包规'] ?? '',
    demandPrice: row.attributes['目标价'] ?? '', demandCode: row.attributes['物料编号'] ?? '',
    demandBrandReplaceable: replaceable, demandNotes: row.attributes['备注1'] ?? '',
    demandNotes2: row.attributes['备注2'] ?? '', demandNotes3: row.attributes['备注3'] ?? '',
  }
}
