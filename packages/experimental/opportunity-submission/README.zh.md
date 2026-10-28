---
description: "读取本地采购文件，通过已认证的企业服务完成可恢复的五阶段商机提报，并提供标准 DSH 专家入口。"
kind: "package-bundle"
---

# 商机提报

[English](README.md) | 中文

## 概述

此可选业务包为标准桌面端或 Web 应用增加 **商机提报专家** Preset、`opportunity-submission` Skill 和六个业务工具。它读取本地 XLSX、UTF-8 CSV 采购文件，保留来源行标识，完成物料检测、必填属性补齐和商机预填，在正式提交前请求用户明确确认。本地任务以 DSH 存储为准；企业鉴权、识别与正式提报由服务端负责。

## 目录

- [使用业务包](#use-the-bundle)
- [业务执行](#business-execution)
- [验证](#verification)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-the-bundle"></a>
## 使用业务包

在标准应用 Profile 之后挂载 `cordis.patch.yml`。`LINGXI_API_BASE_URL` 指定已有业务 API 源站，省略时只允许本地导入。`LINGXI_AUTHORIZATION` 在每次请求时通过 DSH credentials 解析，内容为现有系统签发给 `lingxi-submit` 的短期 Bearer 授权。五个操作均使用已有 `/nova-api/` 路由。桌面端从该令牌填写接口要求的转发头，由业务服务验证签名和权限。DSH 模型登录或客户端填写 ERP 不代表业务授权，本插件不加载签名私钥。

选择 **商机提报专家**，或要求默认助手使用已注册的 Skill。提供本地文件路径和已知的商机字段。交互使用标准 DSH 对话、工具结果和用户问答，不安装定制 Client 插件。本地原文件不上传，但结构化物料仍会发送到企业服务进行识别和正式提报。

配置管理文件与行数上限、识别批次大小、HTTP 超时、响应上限、预览数量及业务默认值。默认金额为 **1 万元**、采购模式为 `4-4`、报价截止为导入后七天、允许品牌替换。这些是供用户确认的默认选项，不用于编造物料事实。文件中的客户主数据号及用户明确输入优先；企业预填可以替换暂定的金额、名称和截止时间，但不能覆盖用户明确输入。

<a id="business-execution"></a>
## 业务执行

| 工具 | 行为 |
|---|---|
| `opportunity_start` | 通过 DSH 文件权限读取本地文件；定位真实表头及客户元数据；为调用会话保存一份任务。 |
| `opportunity_status` | 读取持久进度、可编辑商机字段、有界物料样本及缺失项。 |
| `opportunity_advance` | 执行检测、必填属性补齐或预填；将结果不明的提交保持阻断，等待业务系统核验。 |
| `opportunity_refill` | 一键批量回填未校验或有缺失的有效物料；保留来源、用户值和当前阶段，缺失仅作提示。 |
| `opportunity_update` | 按来源行 ID 保存用户明确修正，并使依赖校验失效。 |
| `opportunity_submit` | 打开六字段同页完整表单；用户填写或选择后直接提交，不追加确认；发送前保存状态，必须取得真实商机编号。 |

阶段依次为 `detect → complete → prefill → ready → submitted`。中断的提交保留为 `submitting` 或 `unknown`，不能编辑、覆盖或自动重新提交。每个只读批次成功后先保存再执行下一批；失败批次可以重试，已完成批次在桌面重启后仍保留。同一会话的并发操作被拒绝。其他会话不能通过工具参数选择或读取该任务。

插件直接调用现有 POST API：`/nova-api/onepage/material/category-brand/recognize`、`/nova-api/onepage/material/invalid/check`、`/nova-api/aiRecognition/materials/recognize`、`/nova-api/opportunity/prefill/query` 和 `/nova-api/oppo/direct/submit`。安装此业务包仅改变本地 DSH 组合，业务服务仍作为外部依赖。响应采用 `{code:0,data:...}`，直提 API 的 `data` 是商机编号字符串。转发头仅从已有签名凭据取值，凭据真实性由业务服务验签确认。

现有 API 保留了历史来源字段名，但仅将其用于追溯。本地文件的 `source.pageId` 使用真实文件字节计算出的 `urn:sha256:` 内容标识；`source.sheetId` 标识已持久化的 `dsh-materials:` 任务物料集合。`snapshotVersion` 记录用户确认的数据版本，`originalFileName` 保留原文件名。当前提交校验器只检查这些引用非空，不读取外部工作表。本地命名空间不表示存在 JoySpace 文档。

识别返回必须完整匹配请求的行 ID 集合，不依赖返回顺序。明确无效物料被排除。聚合有效性结论 `isInvalidOppo` 缺失时拒绝结果；非供应及风险供应商附加标志允许缺省，返回的无效原因保留为提示。可空描述字段保持未知。`无` 等占位值不能满足必填属性。自动回填保存真实识别值；未填上的字段仅作提示，不阻塞预填、确认或提交，不因此排除有效物料。`blockingIssueCount` 单独统计真正阻塞提交的错误。用户修改原始物料字段时重新执行相关检测；修改已确认属性时保留其他来源数据。最终提交使用 采用 DSH 标准组件的同页完整表单，解析值和默认值仅作建议。用户填写或选择客户主数据号、商机名称、金额（万元）、采购模式、报价截止时间和品牌替代要求后，点击提交即调用业务接口，不再追加确认。表单展示物料范围和未回填提示，所有六个字段必须提供有效值；六个字段同时展示，金额使用数字框，采购模式和品牌替代使用下拉框，截止时间使用日期时间选择器；点击“暂不提交”不会创建商机。表单草稿按会话与请求隔离保存，切换会话或重新打开同一面板时保留。用户修改品牌替代要求时重新检测物料；范围变化时要求重新查看表单。

<a id="verification"></a>
## 验证

包测试使用合成本地采购工作簿与 loopback 企业服务，采用隔离的真实持久存储和标准 DSH 问答。记录会话场景位于 [opportunity-submission](../../../snapshots/session/opportunity-submission/snapshot.yml)。真实企业部署、SSO、下游权限和正式建单必须单独进行环境验证；模拟接口测试成功不能证明这些结果。

<a id="dev-note"></a>
## 开发备注

无。

<a id="model-experience"></a>
## 模型体验

### 业务工具与任务信息

#### 模型看到什么

六个 `opportunity_*` 工具 Schema、真实进度及表单值、有界物料样本和问题、明确默认值，以及确认成功后的真实商机编号。原始文件字节、完整识别批次、凭据和签名私钥不会作为结果返回给模型。

#### Token 影响

业务包挂载期间保留工具 Schema。完整表单由配套的商机表单插件提供，只接管本包的六字段请求，不改变其他问答界面。每次调用追加有界结果。全量物料保存在本地任务存储中，不在每轮模型请求中重复传递。

#### KV Cache 影响

稳定工具 Schema 保持原本可复用的前缀。工具结果追加任务历史；业务包配置、Schema 文本或所选 Preset 变化时，相关请求前缀可能失效。

### 按需业务 Skill

#### 模型看到什么

Skill 目录描述将本地文件提报请求路由到[随包提供的 Skill](assets/opportunity-submission/SKILL.md)。正文只在调用时加载，负责指导模型执行业务规程。

#### Token 影响

目录展示简短条目，加载 Skill 后将其指令追加到会话。业务状态和执行权限仍由工具与存储负责。

#### KV Cache 影响

插件挂载期间目录保持稳定。Skill 加载追加指令；修改随包 Skill 会改变之后加载的指令文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **既有业务访问** — 业务地址和既有 Nova 协议授权必须可用；DSH 模型账号不包含这些企业权限。
- **输入格式** — 支持 XLSX 和 UTF-8 CSV。图片和旧二进制 XLS 需要单独的本地解码器，当前会明确拒绝，避免误解析。
- **本地连续性** — 同一 DSH 存储中的任务支持重启恢复，不提供跨设备同步或任意任务分叉。
- **外部写入不确定性** — 现有直提 API 没有按本地任务提供幂等提交或状态查询。本地记录不能保证业务恰好创建一次；结果不明时保持阻断，必须在业务系统核验。
