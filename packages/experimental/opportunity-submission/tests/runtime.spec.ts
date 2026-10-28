/** Real Loader business-flow checks with local files, durable storage, and a loopback enterprise fixture. @author hanzhichao7 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ExcelJS from 'exceljs'
import { load as loadYaml } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import UserQuestions, { type AskUserQuestionRequest, type AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as OpportunitySubmission from '../src/index.ts'

const rowSchema = z.object({ itemId: z.string(), demandSkuName: z.string() }).loose()
const batchSchema = z.object({ itemList: z.array(rowSchema) })
const attributeBatchSchema = z.array(z.object({ indexCode: z.string() }).loose())
const submittedSchema = z.object({
  source: z.object({
    pageId: z.string().regex(/^urn:sha256:[a-f0-9]{64}$/u),
    sheetId: z.string().regex(/^dsh-materials:[a-f0-9-]{36}$/u),
    originalFileName: z.string(), snapshotVersion: z.string().regex(/^[0-9]+$/u),
  }).strict(),
  opportunity: z.object({ contractNumber: z.string(), projectName: z.string(), amount: z.number() }).loose(),
  materials: z.array(z.object({
    sourceRowId: z.string(), categoryFullName: z.string(),
    requiredAttributes: z.record(z.string(), z.string()), valid: z.literal(true),
  }).loose()),
})
const viewSchema = z.object({
  taskId: z.string(), phase: z.string(), revision: z.number(), total: z.number(), valid: z.number(), excluded: z.number(),
  form: z.object({ contractNumber: z.string(), projectName: z.string(), amount: z.number(), purchaseMode: z.string() }).loose(),
  issueCount: z.number(), blockingIssueCount: z.number(), issues: z.array(z.string()),
  defaults: z.array(z.string()),
  materials: z.array(z.object({ id: z.string(), valid: z.boolean().nullable(), missingFields: z.array(z.string()) }).loose()),
  oppoCode: z.string().optional(),
})

/**
 * Own a deterministic handoff used to place requests at specific concurrency points.
 * @returns A promise and its resolver; no scheduler delay is needed.
 */
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/**
 * Boot the production plugin through cordis.yml with private storage and only external enterprise/UI fixtures replaced.
 * @param options - Initial material count, batch size, and HTTP deadline for the isolated test.
 * @returns Session-bound tool invocations, captured enterprise requests, and controlled external outcomes.
 */
async function fixture(options: {
  rows?: number
  batchSize?: number
  requestTimeoutMs?: number
  maxOutputBytes?: number
  noOrigin?: boolean
  noAuthorization?: boolean
  expert?: boolean
  attributes?: Record<string, string>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-opportunity-loader-'))
  const authorizationEnv = `OPPORTUNITY_FIXTURE_${basename(root).replace(/[^A-Za-z0-9_]/gu, '_')}_AUTHORIZATION`
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'procurement.xlsx')
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('物料')
  sheet.addRow(['填写说明'])
  sheet.addRow(['客户合同主数据号：', 'VSP-20260101000001'])
  sheet.addRow(['商机报价维度', '整个商机统一报价要求'])
  sheet.addRow(['来源于客户的需求'])
  const attributes = options.attributes ?? {}
  sheet.addRow(['*采购物料（物资）名称', '品牌', '*规格参数（尽量穷举） or 型号', '*需求单位', '*采购数量', ...Object.keys(attributes)])
  for (let index = 0; index < (options.rows ?? 2); index++) {
    sheet.addRow([`物料${index + 1}`, '', `M-${index + 1}`, '个', index + 1, ...Object.values(attributes)])
  }
  await workbook.xlsx.writeFile(source)

  const calls: { operation: string; body: unknown; headers: IncomingMessage['headers'] }[] = []
  const requests: AskUserQuestionRequest[] = []
  const controls = {
    answer: '确认提交', invalidIds: new Set<string>(), missingIds: new Set<string>(),
    formValues: {} as Record<string, string>, formAnswer: 'normal' as 'normal' | 'skip' | 'duplicate' | 'ambiguous',
    malformedCategory: '' as '' | 'missing' | 'duplicate',
    failInvalidCall: 0, invalidCalls: 0,
    categoryBarrier: undefined as { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined,
    submitBarrier: undefined as { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined,
    submit: 'success' as 'success' | 'disconnect' | 'missing-code',
    nullDescriptions: false, missingValidity: false, minimalValidity: false, longRisk: '',
    extraAttribute: undefined as { name: string; value: string } | undefined,
  }
  /** Respond only with controlled enterprise fixtures; malformed test requests fail the actual HTTP operation. */
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      const routes: Record<string, string> = {
        '/nova-api/onepage/material/category-brand/recognize': 'category-brand',
        '/nova-api/onepage/material/invalid/check': 'invalid-check',
        '/nova-api/aiRecognition/materials/recognize': 'attributes',
        '/nova-api/opportunity/prefill/query': 'prefill',
        '/nova-api/oppo/direct/submit': 'submit',
      }
      const operation = routes[pathname] ?? pathname
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const value: unknown = chunk
        if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
        else throw new Error('Unexpected HTTP request chunk type')
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const body: unknown = raw ? JSON.parse(raw) : null
      calls.push({ operation, body, headers: request.headers })
      let data: unknown
      switch (operation) {
        case 'category-brand': {
          const rows = batchSchema.parse(body).itemList
          const barrier = controls.categoryBarrier
          if (barrier !== undefined) { barrier.entered.release(); await barrier.release.promise }
          const results = rows.map(row => ({ itemId: row.itemId,
            normalizedBrandName: controls.nullDescriptions ? null : `品牌-${row.itemId}`,
            normalizedBrandCode: controls.nullDescriptions ? null : 'B-1',
            categoryFullName: controls.nullDescriptions ? null : `类目-${row.itemId}`,
            categoryFullPath: controls.nullDescriptions ? null : '1/2/3',
          })).reverse()
          if (controls.malformedCategory === 'missing') results.pop()
          if (controls.malformedCategory === 'duplicate' && results[0] !== undefined) results.push(results[0])
          data = results
          break
        }
        case 'invalid-check': {
          controls.invalidCalls++
          if (controls.failInvalidCall === controls.invalidCalls) {
            response.writeHead(503).end()
            return
          }
          data = batchSchema.parse(body).itemList.map(row => ({ itemId: row.itemId,
            ...(controls.missingValidity ? {} : { isInvalidOppo: controls.invalidIds.has(row.itemId) ? 1 : 0 }),
            ...(controls.minimalValidity ? {} : { isNonSupplies: 0, haveRiskVenderName: 0 }),
            invalidOppoTags: controls.invalidIds.has(row.itemId) ? { NO_MODEL_SPEC: '缺少型号规格' } : {},
            baseInvalidCheckResult: controls.nullDescriptions ? null : controls.longRisk ? [controls.longRisk] : [],
            riskVenderNameList: controls.nullDescriptions ? null : [],
          })).reverse()
          break
        }
        case 'attributes': {
          data = attributeBatchSchema.parse(body).map(row => ({ indexCode: row.indexCode,
            requiredFieldKeys: ['单位', '采购数量', '材质', ...(controls.extraAttribute === undefined ? [] : [controls.extraAttribute.name])],
            success: !controls.missingIds.has(row.indexCode),
            attributeValues: { 材质: controls.missingIds.has(row.indexCode) ? '无' : '钢', ...(controls.extraAttribute === undefined ? {} : { [controls.extraAttribute.name]: controls.extraAttribute.value }) },
            missingFields: controls.missingIds.has(row.indexCode) ? ['材质'] : [],
            failReason: controls.nullDescriptions ? null : '',
          })).reverse()
          break
        }
        case 'prefill': data = { projectName: '企业预填商机', opportunityAmount: '2.5' }; break
        case 'submit':
          submittedSchema.parse(body)
          if (controls.submitBarrier !== undefined) {
            controls.submitBarrier.entered.release()
            await controls.submitBarrier.release.promise
          }
          if (controls.submit === 'disconnect') { request.socket.destroy(); return }
          data = controls.submit === 'missing-code' ? '' : 'OPPO-TEST-001'
          break
        default: response.writeHead(404).end(); return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 0, data }))
    } catch (_error) {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 1 }))
    }
  }
  const server = createServer((request, response) => { void respond(request, response) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Loopback fixture did not receive a TCP address')
  const origin = `http://127.0.0.1:${address.port}`
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem], ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
    ['@deepseek-ai/dsh-skill', SkillRegistry], ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson], ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials], ['@deepseek-ai/dsh-user-questions', UserQuestions],
    ['@deepseek-ai/dsh-experimental-opportunity-submission', OpportunitySubmission], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  const configs: Record<string, object> = {
    '@deepseek-ai/dsh-storage-json': { root: join(root, 'storage') },
    '@deepseek-ai/dsh-storage-domain': { backend: 'json' },
    '@deepseek-ai/dsh-credentials-local': { path: join(root, '.credentials.yaml'), watch: false },
    '@deepseek-ai/dsh-experimental-opportunity-submission': {
      ...(options.noOrigin ? {} : { apiBaseUrl: origin }),
      authorizationEnv,
      batchSize: options.batchSize ?? 50, requestTimeoutMs: options.requestTimeoutMs ?? 10000,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    },
    '@deepseek-ai/dsh-agent-loop': { agents: [] },
  }
  if (options.expert) {
    const patch: unknown = loadYaml(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
    const rows = z.array(z.object({ insert: z.array(z.unknown()) })).parse(patch).flatMap(item => item.insert)
    const declaration = z.object({
      id: z.literal('opportunity-submission-expert'), name: z.literal('@deepseek-ai/dsh-agent-preset'),
      config: z.object({ id: z.string(), name: z.string(), description: z.string(), plugins: z.array(z.object({
        id: z.string(), name: z.string(), config: z.unknown().optional(),
      })) }),
    }).parse(rows.find(row => typeof row === 'object' && row !== null && 'id' in row && row.id === 'opportunity-submission-expert'))
    modules.set('@deepseek-ai/dsh-agent-preset-registry', AgentPresets)
    modules.set('@deepseek-ai/dsh-agent-preset', AgentPreset)
    modules.set('@deepseek-ai/dsh-persona', Persona)
    modules.set('@deepseek-ai/dsh-tool-skill', ToolSkill)
    modules.set('@deepseek-ai/dsh-tool-ask-user', ToolAskUser)
    configs['@deepseek-ai/dsh-agent-preset-registry'] = { default: declaration.config.id }
    configs['@deepseek-ai/dsh-agent-preset'] = { ...declaration.config,
      plugins: declaration.config.plugins.map(row => ({ ...row, name: `cordis:${row.name}` })),
    }
  }
  const configPath = join(root, 'cordis.yml')
  const scopedModules = ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-tool-ask-user']
  await writeFile(configPath, [...modules.keys()].filter(name => !scopedModules.includes(name)).map(name => `- name: 'cordis:${name}'\n${configs[name] === undefined ? '' : `  config: ${JSON.stringify(configs[name])}\n`}`).join(''))
  let context: Context
  let agent: Awaited<ReturnType<AgentLoop['create']>>
  let sequence = 0

  /** Start a fresh Host over the same task storage; the session owner remains stable across restarts. */
  async function boot(): Promise<void> {
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    for (const [specifier, plugin] of modules) context.loader.builtins[specifier] = plugin
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    const jwtHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const jwtClaims = Buffer.from(JSON.stringify({
      erp: 'fixture-user', erpName: '测试用户', requestId: 'fixture-request', aud: 'lingxi-submit',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url')
    // This unsigned fixture tests forwarding only; signature verification remains owned by the actual business server.
    if (!options.noAuthorization) {
      await context.credentials.set(credentialRef(authorizationEnv), `Bearer ${jwtHeader}.${jwtClaims}.c3ludGhldGljLXNpZ25hdHVyZQ`)
    }
    agent = await context.agentLoop.create(SessionId('opportunity-loader'), {}, { cwd: root })
    context.on('user-questions/request', (request) => {
      requests.push(request)
      if (controls.answer === '暂不提交') return Promise.resolve({ answers: [] })
      const answers: AskUserQuestionAnswerItem[] = request.questions.map((question) => {
        const key = question.id.split('-').at(-1)!
        const value = controls.formValues[key]
        return value === undefined ? { id: question.id, selected: [question.options![0]!.label] }
          : { id: question.id, selected: [], custom: value }
      })
      if (controls.formAnswer === 'skip') answers[0] = { id: answers[0]!.id, selected: [] }
      if (controls.formAnswer === 'duplicate') answers[1] = answers[0]!
      if (controls.formAnswer === 'ambiguous') answers[0] = { ...answers[0]!, custom: '另一个值', selected: ['当前值'] }
      return Promise.resolve({ answers })
    })
  }
  await boot()
  onTestFinished(() => context.fiber.dispose())

  /** Execute the registered model-facing tool, preserving validation, identity, and business errors. */
  const invoke = (name: string, args: object = {}, signal = new AbortController().signal) => context.tools.execute({ name, callId: ToolCallId(`opportunity-${++sequence}`), arguments: args, agent, signal })
  /** Execute and decode a successful canonical tool result; failures include their actual model-visible text. */
  async function success(name: string, args: object = {}) {
    const result = await invoke(name, args)
    expect(result.isError, result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).not.toBe(true)
    return viewSchema.parse(result.value)
  }
  /** Reach the last pre-submission stage through the three actual enterprise operations. */
  async function ready() {
    await success('opportunity_start', { path: source })
    expect((await success('opportunity_advance')).phase).toBe('complete')
    expect((await success('opportunity_advance')).phase).toBe('prefill')
    expect((await success('opportunity_advance')).phase).toBe('ready')
  }
  return {
    root, source, calls, requests, controls, invoke, success, ready,
    context: () => context, agent: () => agent,
    restart: async () => { await context.fiber.dispose(); await boot() },
  }
}

describe('local opportunity submission through real Cordis Loader composition', () => {
  it('submits the six human-entered form values directly without a second confirmation', async () => {
    const f = await fixture()
    await f.ready()
    const quoteDeadline = new Date(Date.now() + 172800000).toISOString()
    f.controls.formValues = { contractNumber: 'VSP-20260202000002', projectName: '用户表单输入商机', amount: '12.3456',
      purchaseMode: '6-1', quoteDeadline, brandReplaceable: '不允许替代品牌' }
    const result = await f.success('opportunity_submit')
    expect(result).toMatchObject({ phase: 'submitted', defaults: [], form: { contractNumber: 'VSP-20260202000002',
      projectName: '用户表单输入商机', amount: 12.3456, purchaseMode: '6-1', quoteDeadline, brandReplaceable: false } })
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.questions.map(question => question.header)).toEqual([
      '客户主数据号', '商机名称', '商机金额', '采购模式', '报价截止时间', '品牌替代要求',
    ])
    const payload = submittedSchema.parse(f.calls.find(call => call.operation === 'submit')!.body)
    expect(payload.opportunity).toMatchObject({ contractNumber: 'VSP-20260202000002', projectName: '用户表单输入商机',
      amount: 12.3456, firstPurchaseModel: '6', secondPurchaseModel: '1', customerActualQuoteDeadline: Date.parse(quoteDeadline),
      quoteRequirements: { brandReplaceable: 0 } })
    expect(f.calls.filter(call => call.operation === 'submit')).toHaveLength(1)
    const invalid = f.calls.filter(call => call.operation === 'invalid-check')
    expect(invalid).toHaveLength(2)
    expect(batchSchema.parse(invalid[1]!.body).itemList[0]).toMatchObject({ demandBrandReplaceable: 0 })
  })

  it.each(['skip', 'duplicate', 'ambiguous'] as const)('rejects %s form answers without dispatching submission', async (formAnswer) => {
    const f = await fixture()
    await f.ready()
    f.controls.formAnswer = formAnswer
    expect((await f.invoke('opportunity_submit')).isError).toBe(true)
    expect((await f.success('opportunity_status')).phase).toBe('ready')
    expect(f.calls.some(call => call.operation === 'submit')).toBe(false)
  })

  it.each([
    { amount: 'not-a-number' }, { amount: '0' }, { amount: '1.00001' }, { amount: '0x10' },
    { purchaseMode: 'invalid' }, { contractNumber: '' }, { projectName: '' },
    { quoteDeadline: '2020-01-01T00:00:00+08:00' },
  ])('rejects invalid final form input %j before the business write', async (values) => {
    const f = await fixture()
    await f.ready()
    f.controls.formValues = values
    expect((await f.invoke('opportunity_submit')).isError).toBe(true)
    expect(f.calls.some(call => call.operation === 'submit')).toBe(false)
    expect((await f.success('opportunity_status')).phase).toBe('ready')
  })

  it('allows the final form to correct an invalid prefill rather than blocking its input', async () => {
    const f = await fixture()
    await f.ready()
    await f.success('opportunity_update', { form: { contractNumber: '' } })
    f.controls.formValues = { contractNumber: 'VSP-20260202000002' }
    expect((await f.success('opportunity_submit')).phase).toBe('submitted')
    expect(f.requests).toHaveLength(1)
  })

  it('loads the shipped expert declaration and selects its persona, skill, and business tools for a blank session', async () => {
    const f = await fixture({ expert: true })
    const ctx = f.context()
    expect(await ctx.agentPresets.list()).toEqual([{
      id: 'opportunity-submission', name: '商机提报专家', description: '从本地采购清单完成物料检测、信息补齐与商机提报。',
    }])
    expect(await ctx.agentPresets.select(f.agent(), 'opportunity-submission')).toBe('opportunity-submission')
    expect(ctx.sessionProjections.stateOf(f.agent().session, 'agentPreset')).toBe('opportunity-submission')
    const scope = assembleContextFor(f.agent())
    expect(renderPrompt(await ctx.systemPrompt.assemble(scope))).toContain('你是商机提报专家')
    expect((await ctx.skills.list({ scope: scope.scope })).some(skill => skill.name === 'opportunity-submission')).toBe(true)
    expect(ctx.tools.schemas(f.agent()).map(tool => tool.name)).toEqual(expect.arrayContaining([
      'opportunity_start', 'opportunity_status', 'opportunity_advance', 'opportunity_refill', 'opportunity_update', 'opportunity_submit',
      'skill', 'ask_user_question',
    ]))
    const skill = await f.invoke('skill', { name: 'opportunity-submission' })
    expect(skill.isError).not.toBe(true)
    expect(skill.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('五阶段流转')
    expect((await f.success('opportunity_start', { path: f.source })).phase).toBe('detect')
  })

  it('imports a local template, preserves unordered row identities, excludes invalid materials, and submits only after standard confirmation', async () => {
    const f = await fixture({ attributes: { 备注1: '原始客户备注' } })
    const sourceBefore = await readFile(f.source)
    f.controls.invalidIds.add('物料:7')
    const imported = await f.success('opportunity_start', { path: f.source, form: { projectName: '用户商机', amount: 3 } })
    expect(imported).toMatchObject({ phase: 'detect', total: 2, form: { contractNumber: 'VSP-20260101000001', projectName: '用户商机', amount: 3 } })
    expect(f.calls).toHaveLength(0)
    expect((await f.success('opportunity_advance')).phase).toBe('complete')
    expect((await f.success('opportunity_advance')).phase).toBe('prefill')
    expect((await f.success('opportunity_advance')).form).toMatchObject({ projectName: '用户商机', amount: 3 })
    expect(f.calls.some(call => call.operation === 'submit')).toBe(false)
    const result = await f.success('opportunity_submit')
    expect(result).toMatchObject({ phase: 'submitted', oppoCode: 'OPPO-TEST-001', valid: 1, excluded: 1 })
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.questions[0]!.detail).toContain('VSP-20260101000001')
    expect(f.requests[0]!.questions[0]!.detail).toContain('金额：3 万元')
    const payload = submittedSchema.parse(f.calls.find(call => call.operation === 'submit')!.body)
    expect(payload.source).toMatchObject({
      pageId: `urn:sha256:${createHash('sha256').update(sourceBefore).digest('hex')}`,
      sheetId: `dsh-materials:${imported.taskId}`, originalFileName: 'procurement.xlsx',
    })
    expect(payload.source).not.toHaveProperty('sourceType')
    expect(f.calls.find(call => call.operation === 'submit')!.body).not.toHaveProperty('submissionKey')
    const authorization = f.calls.find(call => call.operation === 'submit')!.headers
    expect(authorization.authorization).toMatch(/^Bearer /u)
    expect(authorization.erp).toBe('fixture-user')
    expect(authorization.erpname).toBe(Buffer.from('测试用户').toString('base64url'))
    expect(authorization.erpnameencoding).toBe('base64url-utf8')
    expect(authorization['x-nova-target-audience']).toBe('lingxi-submit')
    expect(authorization['x-nova-request-id']).toBe('fixture-request')
    expect(payload.materials).toHaveLength(1)
    expect(payload.materials[0]).toMatchObject({ sourceRowId: '物料:6', categoryFullName: '类目-物料:6', requiredAttributes: { 材质: '钢' } })
    expect(payload.materials[0]!.requiredAttributes).not.toHaveProperty('备注1')
    expect(await f.success('opportunity_submit')).toMatchObject({ phase: 'submitted' })
    expect(f.calls.filter(call => call.operation === 'submit')).toHaveLength(1)
    expect(await readFile(f.source)).toEqual(sourceBefore)
  })

  it.each(['missing', 'duplicate'] as const)('rejects %s category response identities without advancing or writing a submission', async (malformed) => {
    const f = await fixture()
    f.controls.malformedCategory = malformed
    await f.success('opportunity_start', { path: f.source })
    const failure = await f.invoke('opportunity_advance')
    expect(failure.isError).toBe(true)
    expect(failure.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('RESULT_ID_MISMATCH')
    expect((await f.success('opportunity_status')).phase).toBe('detect')
    expect(f.calls.some(call => call.operation === 'invalid-check' || call.operation === 'submit')).toBe(false)
  })

  it('continues with missing attribute notices, accepts corrections, and rejects premature submission', async () => {
    const f = await fixture()
    f.controls.missingIds.add('物料:6')
    await f.success('opportunity_start', { path: f.source })
    expect((await f.invoke('opportunity_submit')).isError).toBe(true)
    await f.success('opportunity_advance')
    const waiting = await f.success('opportunity_advance')
    expect(waiting).toMatchObject({ phase: 'prefill', issueCount: 1, blockingIssueCount: 0 })
    expect(waiting.issues[0]).toContain('缺少材质')
    const attributesCalls = f.calls.filter(call => call.operation === 'attributes').length
    await f.success('opportunity_update', { materials: [{ id: '物料:6', attributes: [{ name: '材质', value: '铝' }] }] })
    expect((await f.success('opportunity_advance')).phase).toBe('ready')
    expect(f.calls.filter(call => call.operation === 'attributes')).toHaveLength(attributesCalls)
    await f.success('opportunity_submit')
    expect(submittedSchema.parse(f.calls.find(call => call.operation === 'submit')!.body).materials[0]!.requiredAttributes.材质).toBe('铝')
  })

  it('revalidates previously satisfied requirements when the user clears an attribute', async () => {
    const f = await fixture()
    await f.ready()
    const updated = await f.success('opportunity_update', { materials: [{ id: '物料:6', attributes: [{ name: '材质', value: '' }] }] })
    expect(updated.phase).toBe('ready')
    expect(updated.issues).toEqual(expect.arrayContaining([expect.stringContaining('缺少材质')]))
    expect(updated).toMatchObject({ blockingIssueCount: 0 })
    expect((await f.success('opportunity_advance')).phase).toBe('ready')
    await f.success('opportunity_submit')
    expect(f.requests[0]!.questions[0]!.detail).toContain('缺少材质')
    expect(submittedSchema.parse(f.calls.find(call => call.operation === 'submit')!.body).materials[0]!.requiredAttributes).not.toHaveProperty('材质')
  })

  it('batch refills only incomplete rows at ready without rewinding the stage or replacing user values', async () => {
    const f = await fixture({ rows: 3 })
    f.controls.missingIds.add('物料:6')
    f.controls.missingIds.add('物料:7')
    expect((await f.invoke('opportunity_refill')).isError).toBe(true)
    await f.success('opportunity_start', { path: f.source })
    expect((await f.invoke('opportunity_refill')).isError).toBe(true)
    await f.success('opportunity_advance')
    await f.success('opportunity_advance')
    await f.success('opportunity_advance')
    await f.success('opportunity_update', { materials: [{ id: '物料:8', attributes: [{ name: '材质', value: '铜' }] }] })
    f.controls.missingIds.delete('物料:6')
    const filled = await f.success('opportunity_refill')
    expect(filled).toMatchObject({ phase: 'ready', valid: 3, issueCount: 1, blockingIssueCount: 0 })
    const calls = f.calls.filter(call => call.operation === 'attributes')
    expect(attributeBatchSchema.parse(calls.at(-1)!.body).map(row => row.indexCode)).toEqual(['物料:6', '物料:7'])
    expect((await f.success('opportunity_advance')).phase).toBe('ready')
    expect(f.calls.filter(call => call.operation === 'attributes')).toHaveLength(calls.length)
    await f.success('opportunity_submit')
    const materials = submittedSchema.parse(f.calls.find(call => call.operation === 'submit')!.body).materials
    expect(materials).toHaveLength(3)
    expect(materials[0]!.requiredAttributes.材质).toBe('钢')
    expect(materials[1]!.requiredAttributes).not.toHaveProperty('材质')
    expect(materials[2]!.requiredAttributes.材质).toBe('铜')
    expect(f.requests[0]!.questions[0]!.detail).toContain('缺少材质')
    expect((await f.invoke('opportunity_refill')).isError).toBe(true)
  })

  it('uses enterprise prefill when the user supplied no field override and leaves cancellation ready for later', async () => {
    const f = await fixture()
    await f.ready()
    const status = await f.success('opportunity_status')
    expect(status.form).toMatchObject({ projectName: '企业预填商机', amount: 2.5, purchaseMode: '4-4' })
    expect(status.defaults).not.toContain('projectName')
    expect(status.defaults).not.toContain('amount')
    expect(status.defaults).toContain('purchaseMode')
    f.controls.answer = '暂不提交'
    expect((await f.success('opportunity_submit')).phase).toBe('ready')
    expect(f.calls.some(call => call.operation === 'submit')).toBe(false)
    f.controls.answer = '确认提交'
    expect((await f.success('opportunity_submit')).phase).toBe('submitted')
  })

  it('owns tasks by the authenticated calling session and does not replace unfinished work', async () => {
    const f = await fixture()
    const imported = await f.success('opportunity_start', { path: f.source })
    expect((await f.invoke('opportunity_start', { path: f.source, new_task: true })).isError).toBe(true)
    const ctx = f.context()
    const other = await ctx.agentLoop.create(SessionId('another-owner'), {}, { cwd: f.root })
    const foreign = await ctx.tools.execute({
      name: 'opportunity_status', callId: ToolCallId('foreign-owner-status'), arguments: { taskId: imported.taskId },
      agent: other, signal: new AbortController().signal,
    })
    expect(foreign.isError).toBe(true)
    expect(foreign.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('NO_TASK')
    const anonymous = await ctx.tools.execute({
      name: 'opportunity_status', callId: ToolCallId('anonymous-status'), arguments: {}, signal: new AbortController().signal,
    })
    expect(anonymous.isError).toBe(true)
    expect((await f.success('opportunity_status')).taskId).toBe(imported.taskId)
  })

  it('invalidates downstream checks after a source edit and refuses to submit the previous ready result', async () => {
    const f = await fixture()
    f.controls.extraAttribute = { name: '旧识别属性', value: '旧值' }
    await f.ready()
    const changed = await f.success('opportunity_update', { materials: [{ id: '物料:6', model: 'M-CORRECTED' }] })
    expect(changed.phase).toBe('detect')
    expect((await f.invoke('opportunity_submit')).isError).toBe(true)
    const previousCategoryCalls = f.calls.filter(call => call.operation === 'category-brand').length
    await f.success('opportunity_advance')
    const requests = f.calls.filter(call => call.operation === 'category-brand')
    expect(requests).toHaveLength(previousCategoryCalls + 1)
    expect(batchSchema.parse(requests.at(-1)!.body).itemList.map(row => row.itemId)).toEqual(['物料:6'])
    f.controls.extraAttribute = { name: '新识别属性', value: '新值' }
    await f.success('opportunity_advance')
    await f.success('opportunity_advance')
    await f.success('opportunity_submit')
    const material = submittedSchema.parse(f.calls.find(call => call.operation === 'submit')!.body).materials.find(row => row.sourceRowId === '物料:6')!
    expect(material.requiredAttributes).toMatchObject({ 新识别属性: '新值', 材质: '钢' })
    expect(material.requiredAttributes).not.toHaveProperty('旧识别属性')
  })

  it('allows nullable descriptions but rejects an absent validity decision', async () => {
    const f = await fixture()
    f.controls.nullDescriptions = true
    await f.success('opportunity_start', { path: f.source })
    f.controls.missingValidity = true
    expect((await f.invoke('opportunity_advance')).isError).toBe(true)
    expect((await f.success('opportunity_status')).phase).toBe('detect')
    f.controls.missingValidity = false
    expect((await f.success('opportunity_advance')).phase).toBe('complete')
    expect((await f.success('opportunity_advance')).phase).toBe('prefill')
  })

  it('uses the aggregate validity verdict when supplementary flags are absent and retains invalid reasons', async () => {
    const f = await fixture()
    f.controls.minimalValidity = true
    f.controls.invalidIds.add('物料:6')
    await f.success('opportunity_start', { path: f.source })
    const state = await f.success('opportunity_advance')
    expect(state.phase).toBe('complete')
    expect(state.valid).toBe(1)
    expect(state.materials.find(row => row.id === '物料:6')).toMatchObject({ valid: false, risks: ['缺少型号规格'] })
    expect(state.materials.find(row => row.id === '物料:7')).toMatchObject({ valid: true })
  })

  it('preserves independent source detection fields with the existing enterprise wire types', async () => {
    const f = await fixture({ rows: 1, attributes: {
      包规: '10个/包', 目标价: '25.5', 物料编号: 'CUSTOMER-001',
      备注1: '备注甲', 备注2: '备注乙', 备注3: '备注丙', 品牌是否可替换: '否',
    } })
    await f.success('opportunity_start', { path: f.source })
    await f.success('opportunity_advance')
    const request = batchSchema.parse(f.calls.find(call => call.operation === 'invalid-check')!.body)
    expect(request.itemList).toEqual([{
      itemId: '物料:6', demandSkuName: '物料1', demandBrandName: '', demandModel: 'M-1', demandSaleUnit: '个',
      demandNums: '1', demandPackUnit: '10个/包', demandPrice: '25.5', demandCode: 'CUSTOMER-001',
      demandBrandReplaceable: 0, demandNotes: '备注甲', demandNotes2: '备注乙', demandNotes3: '备注丙',
    }])
  })

  it.each([
    { name: '目标价', value: '36.25', wire: 'demandPrice', expected: '36.25' },
    { name: '品牌是否可替换', value: '否', wire: 'demandBrandReplaceable', expected: 0 },
  ])('reruns detection for the corrected $name source row', async (attribute) => {
    const f = await fixture()
    await f.ready()
    const updated = await f.success('opportunity_update', {
      materials: [{ id: '物料:6', attributes: [{ name: attribute.name, value: attribute.value }] }],
    })
    expect(updated.phase).toBe('detect')
    await f.success('opportunity_advance')
    const calls = f.calls.filter(call => call.operation === 'invalid-check')
    expect(calls).toHaveLength(2)
    const rows = batchSchema.parse(calls.at(-1)!.body).itemList
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ itemId: '物料:6', [attribute.wire]: attribute.expected })
  })

  it('rechecks all materials after the shared brand-replacement option changes', async () => {
    const f = await fixture()
    await f.ready()
    expect((await f.success('opportunity_update', { form: { brandReplaceable: false } })).phase).toBe('detect')
    await f.success('opportunity_advance')
    const calls = f.calls.filter(call => call.operation === 'invalid-check')
    expect(calls).toHaveLength(2)
    const rows = batchSchema.parse(calls.at(-1)!.body).itemList
    expect(rows.map(row => row.itemId)).toEqual(['物料:6', '物料:7'])
    expect(rows.every(row => row.demandBrandReplaceable === 0)).toBe(true)
  })

  it('accepts four-decimal quantities and amounts while rejecting a fifth without changing saved values', async () => {
    const f = await fixture({ rows: 1 })
    await f.success('opportunity_start', { path: f.source, form: { amount: 1.2345 } })
    expect((await f.success('opportunity_update', { materials: [{ id: '物料:6', quantity: 2.3456 }] })).form.amount).toBe(1.2345)
    expect((await f.invoke('opportunity_update', { materials: [{ id: '物料:6', quantity: 2.34567 }] })).isError).toBe(true)
    expect((await f.invoke('opportunity_update', { form: { amount: 1.23456 } })).isError).toBe(true)
    const status = await f.success('opportunity_status')
    expect(status.form.amount).toBe(1.2345)
    expect(status.materials).toEqual([expect.objectContaining({ quantity: 2.3456 })])
    await f.success('opportunity_advance')
    const request = batchSchema.parse(f.calls.find(call => call.operation === 'invalid-check')!.body)
    expect(request.itemList[0]!.demandNums).toBe('2.3456')
  })

  it('bounds the complete JSON tool result including multibyte risk text', async () => {
    const f = await fixture({ rows: 20, maxOutputBytes: 2048 })
    f.controls.longRisk = '风险提醒🛑'.repeat(200)
    await f.success('opportunity_start', { path: f.source })
    const result = await f.invoke('opportunity_advance')
    expect(result.isError).not.toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(2048)
    expect(viewSchema.parse(result.value)).toMatchObject({ total: 20, phase: 'complete' })
    for (const block of result.content) if (block.type === 'text') expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(2048)
  })

  it.each([
    { noOrigin: true, code: 'NOT_CONFIGURED' },
    { noAuthorization: true, code: 'AUTHORIZATION_REQUIRED' },
  ])('preserves a local task without dispatching an unauthorized operation when $code', async (options) => {
    const f = await fixture(options)
    await f.success('opportunity_start', { path: f.source })
    const previousRequests = f.calls.length
    const result = await f.invoke('opportunity_advance')
    expect(result.isError).toBe(true)
    expect(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain(options.code)
    expect(f.calls).toHaveLength(previousRequests)
    expect((await f.success('opportunity_status')).phase).toBe('detect')
  })

  it('uses only the existing signed authorization for all five business requests without an SSO cookie', async () => {
    const f = await fixture()
    await f.ready()
    expect((await f.success('opportunity_submit')).phase).toBe('submitted')
    expect(f.calls.map(call => call.operation)).toEqual(['category-brand', 'invalid-check', 'attributes', 'prefill', 'submit'])
    for (const call of f.calls) {
      expect(call.headers.cookie).toBeUndefined()
      expect(call.headers.authorization).toMatch(/^Bearer /u)
      expect(call.headers.erp).toBe('fixture-user')
      expect(call.headers['x-nova-target-audience']).toBe('lingxi-submit')
    }
  })

  it('keeps completed recognition batches across an HTTP failure and a new Host instance', async () => {
    const f = await fixture({ rows: 3, batchSize: 1 })
    f.controls.failInvalidCall = 2
    const imported = await f.success('opportunity_start', { path: f.source })
    expect((await f.invoke('opportunity_advance')).isError).toBe(true)
    expect((await f.success('opportunity_status')).valid).toBe(1)
    await f.restart()
    expect(await f.success('opportunity_status')).toMatchObject({ taskId: imported.taskId, phase: 'detect', valid: 1 })
    f.controls.failInvalidCall = 0
    expect((await f.success('opportunity_advance')).phase).toBe('complete')
    const ids = f.calls.filter(call => call.operation === 'category-brand').flatMap(call => batchSchema.parse(call.body).itemList.map(row => row.itemId))
    expect(ids.filter(id => id === '物料:6')).toHaveLength(1)
    expect(ids.filter(id => id === '物料:7')).toHaveLength(2)
    expect(ids.filter(id => id === '物料:8')).toHaveLength(1)
  })

  it('traces the exact local file, durable material collection, and confirmed revision without remote document creation', async () => {
    const f = await fixture()
    await f.ready()
    const ready = await f.success('opportunity_status')
    expect((await f.success('opportunity_submit')).phase).toBe('submitted')
    const submitted = submittedSchema.parse(f.calls.find(call => call.operation === 'submit')!.body)
    expect(submitted.source).toEqual({
      pageId: `urn:sha256:${createHash('sha256').update(await readFile(f.source)).digest('hex')}`,
      sheetId: `dsh-materials:${ready.taskId}`, originalFileName: 'procurement.xlsx', snapshotVersion: String(ready.revision + 2),
    })
    expect(f.calls.map(call => call.operation)).toEqual(['category-brand', 'invalid-check', 'attributes', 'prefill', 'submit'])
  })

  it.each(['disconnect', 'missing-code'] as const)('persists unknown after submit %s without inventing a result-query API or repeating the write', async (behavior) => {
    const f = await fixture()
    await f.ready()
    f.controls.submit = behavior
    expect((await f.invoke('opportunity_submit')).isError).toBe(true)
    expect((await f.success('opportunity_status')).phase).toBe('unknown')
    expect((await f.invoke('opportunity_update', { form: { projectName: '另一个商机' } })).isError).toBe(true)
    expect((await f.invoke('opportunity_start', { path: f.source, new_task: true })).isError).toBe(true)
    await f.restart()
    const requestCount = f.calls.length
    expect((await f.success('opportunity_submit')).phase).toBe('unknown')
    expect((await f.success('opportunity_advance')).phase).toBe('unknown')
    expect(f.calls).toHaveLength(requestCount)
    expect(f.calls.filter(call => call.operation === 'submit')).toHaveLength(1)
  })

  it('records uncertainty when cancellation follows enterprise receipt rather than assuming the write was cancelled', async () => {
    const f = await fixture()
    await f.ready()
    const entered = deferred()
    const release = deferred()
    f.controls.submitBarrier = { entered, release }
    const controller = new AbortController()
    const result = f.invoke('opportunity_submit', {}, controller.signal)
    await entered.promise
    controller.abort()
    release.release()
    expect((await result).isError).toBe(true)
    expect((await f.success('opportunity_status')).phase).toBe('unknown')
    await f.success('opportunity_submit')
    expect(f.calls.filter(call => call.operation === 'submit')).toHaveLength(1)
  })

  it('rejects overlapping mutations and unregisters tools and the skill when the owning plugin unloads', async () => {
    const f = await fixture()
    await f.success('opportunity_start', { path: f.source })
    const entered = deferred()
    const release = deferred()
    f.controls.categoryBarrier = { entered, release }
    const first = f.invoke('opportunity_advance')
    await entered.promise
    expect((await f.invoke('opportunity_advance')).isError).toBe(true)
    release.release()
    expect((await first).isError).not.toBe(true)
    const ctx = f.context()
    expect((await ctx.skills.list()).some(skill => skill.name === 'opportunity-submission')).toBe(true)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-opportunity-submission')
    await entry!.fiber!.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name.startsWith('opportunity_'))).toBe(false)
    expect((await ctx.skills.list()).some(skill => skill.name === 'opportunity-submission')).toBe(false)
  })
})
