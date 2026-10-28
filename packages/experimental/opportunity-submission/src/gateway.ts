/** Direct existing-business API transport; secrets stay out of tool arguments, results, and task records. @author hanzhichao7 */
import { z, type ZodType } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Config } from './config.ts'
import { OpportunityError } from './model.ts'

/** Supported enterprise operations; the model cannot supply arbitrary URLs. */
export type Operation = 'category-brand' | 'invalid-check' | 'attributes' | 'prefill' | 'submit'

const envelope = z.object({ code: z.number(), data: z.unknown().optional() })
const BUSINESS_REQUEST_BYTES = 4194304
const paths: Record<Operation, string> = {
  'category-brand': '/nova-api/onepage/material/category-brand/recognize',
  'invalid-check': '/nova-api/onepage/material/invalid/check',
  attributes: '/nova-api/aiRecognition/materials/recognize',
  prefill: '/nova-api/opportunity/prefill/query',
  submit: '/nova-api/oppo/direct/submit',
}

/** Existing business APIs with bounded responses, cancellation, and no implicit retries. */
export class BusinessGateway {
  private readonly origin: URL | undefined

  /**
   * Validate the deployment URL before any business input is accepted.
   * @param ctx - Host credential provider; only the configured reference is resolved.
   * @param config - Enterprise origin and request/response limits.
   */
  constructor(private readonly ctx: Context, private readonly config: Config) {
    credentialRef(config.authorizationEnv)
    if (config.apiBaseUrl === undefined) return
    const url = new URL(config.apiBaseUrl)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('apiBaseUrl must be an origin without credentials, a path, query, or fragment')
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('apiBaseUrl must use HTTPS; HTTP is allowed only on loopback')
    }
    this.origin = url
  }

  /**
   * Call one existing business operation and validate its successful data before it reaches task state.
   * @param operation - Package-owned operation identifier.
   * @param payload - Structured business data; never raw file bytes or identity claims.
   * @param schema - Decoder for the operation's data payload.
   * @param signal - Caller and plugin cancellation.
   * @returns Validated business response data; HTTP and business failures throw safe diagnostics.
   */
  async post<T>(operation: Operation, payload: object, schema: ZodType<T>, signal: AbortSignal): Promise<T> {
    return this.request(paths[operation], payload, schema, signal)
  }

  /**
   * Reject missing local configuration before recording a potentially dispatched submission.
   * @param payload - Exact business snapshot to validate before asking for submission confirmation.
   * @returns Resolution when request size, origin and credential are valid; performs no HTTP request.
   */
  async ensureAccess(payload: object): Promise<void> {
    this.encode(payload)
    await this.headers()
  }

  /**
   * Encode a fixed-operation request before any network side effect.
   * @param payload - Canonical business request, excluding authentication secrets.
   * @returns JSON within the enterprise protocol's complete-body limit; oversized requests are rejected locally.
   */
  private encode(payload: object): string {
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body) > BUSINESS_REQUEST_BYTES) {
      throw new OpportunityError('REQUEST_TOO_LARGE', '请求数据超出 4 MiB 本地上限，请减少本次物料或缩短过长字段。')
    }
    return body
  }

  /**
   * Resolve the current secret only inside transport, without accepting model-controlled origin or identity claims.
   * @returns Wire headers for the next request; missing configuration fails before network dispatch.
   */
  private async headers(): Promise<Record<string, string>> {
    if (this.origin === undefined) throw new OpportunityError('NOT_CONFIGURED', '请配置现有业务 API 地址后继续，已解析的本地任务会保留。')
    const provider = this.ctx.get('credentials')
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    const authorization = await provider?.resolve(credentialRef(this.config.authorizationEnv))
    if (authorization === undefined) {
      throw new OpportunityError('AUTHORIZATION_REQUIRED', '该现有业务接口要求短期调用授权，请配置已有授权的凭据引用；桌面端不签发 JWT，也不需要签名私钥。')
    }
    const token = authorization.value.replace(/^Bearer\s+/u, '')
    let raw: unknown
    try { raw = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) }
    catch (_error) { throw new OpportunityError('INVALID_AUTHORIZATION', '业务授权格式无效，请刷新已有授权。') }
    const claims = z.object({ erp: z.string().min(1), erpName: z.string().min(1), requestId: z.string().min(1),
      aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    }).safeParse(raw)
    if (!claims.success) throw new OpportunityError('INVALID_AUTHORIZATION', '业务授权缺少身份或受众声明，请刷新已有授权。')
    const audiences = typeof claims.data.aud === 'string' ? [claims.data.aud] : claims.data.aud
    if (!audiences.includes('lingxi-submit')) {
      throw new OpportunityError('INVALID_AUTHORIZATION', '该调用授权不是签发给灵犀业务接口的，请使用正确受众的已有授权。')
    }
    // Decoding only supplies required forwarding headers. The existing business server verifies the signature and authority.
    return { ...headers, Authorization: `Bearer ${token}`, erp: claims.data.erp,
      erpName: Buffer.from(claims.data.erpName).toString('base64url'), erpNameEncoding: 'base64url-utf8',
      'X-Nova-Request-Id': claims.data.requestId,
      'X-Nova-Target-Audience': 'lingxi-submit',
    }
  }

  /**
   * Resolve the user's credential per operation and contain untrusted wire data.
   * Redirects are rejected so business authorization cannot follow a login or cross-origin redirect.
   * @param path - Package-owned route on the validated origin.
   * @param payload - Structured POST body for the existing business operation.
   * @param schema - Required successful response decoder.
   * @param signal - Cancellation combined with the configured request deadline.
   * @returns Decoded business data, without exposing raw HTTP failures or credentials.
   */
  private async request<T>(path: string, payload: object, schema: ZodType<T>, signal: AbortSignal): Promise<T> {
    const body = this.encode(payload)
    const headers = await this.headers()
    const response = await fetch(new URL(path, this.origin), {
      method: 'POST', redirect: 'error',
      headers,
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new OpportunityError('ENTERPRISE_HTTP', `企业服务返回 HTTP ${response.status}，请核对服务部署和登录状态。`)
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new OpportunityError('INVALID_RESPONSE', '企业服务未返回业务结果，请核实服务状态。')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > this.config.maxResponseBytes) throw new OpportunityError('RESPONSE_TOO_LARGE', '企业结果超出配置上限，请减小批次或调整响应限额。')
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch (_error) { throw new OpportunityError('INVALID_RESPONSE', '企业服务返回的内容不是有效 JSON，请核实登录与服务状态。') }
    const result = envelope.safeParse(raw)
    if (!result.success || result.data.code !== 0) throw new OpportunityError('ENTERPRISE_REJECTED', '企业服务未确认操作成功，流程已停留在当前阶段，请核实权限和业务输入。')
    const decoded = schema.safeParse(result.data.data)
    if (!decoded.success) throw new OpportunityError('INVALID_RESPONSE', '企业结果字段不完整，流程未推进，请核实接口版本。')
    return decoded.data
  }
}
