---
description: "使用 DSH 标准组件在同一页编辑全部商机提交字段。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-opportunity-submission

[English](README.md) | 中文

## 概述

在同一页核对并填写客户主数据号、商机名称、金额、采购模式、报价截止时间和品牌替代要求。点击“提交商机”后由业务工具直接发送完整表单，点击“暂不提交”则保持任务不变。

## 目录

- [使用](#usage)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="usage"></a>
## 使用

[商机提报业务包](../opportunity-submission/README.zh.md) 挂载此可选浏览器插件。解析及建议值出现在可编辑控件中，金额单位为万元，截止时间选择器显示本地时间。表单采用数字框、文本框、下拉框和一个提交按钮，辅助信息区域保留物料范围和未回填提示。属性缺失不阻塞提交；Host 校验最终表单，只有取得真实业务商机编号后才报告成功。

<a id="implementation"></a>
## 实现

此插件在通用问答编辑器之前注册业务专属入口，只匹配完整且属于同一数据版本的商机字段请求，沿用标准用户回答通道，不改变其他问答。会话草稿在编辑器重新挂载后保留。提交时禁用重复点击，传输失败则保留可编辑值并展示错误。Host 负责鉴权业务调用及结果不明状态，浏览器不会接收业务授权凭据。

<a id="model-experience"></a>
## 模型体验

通过 `dsh-experimental-opportunity-submission` 间接影响模型，将该业务工具的字段问题展示为一个完整表单。

#### KV 缓存影响

不直接使缓存失效；`dsh-experimental-opportunity-submission` 负责模型可见的工具输入与结果。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 完整表单需要 Desktop 或 Web 客户端插件，其他客户端沿用标准多问题交互。草稿只保存在当前 Client 和会话中，不跨设备同步。

<a id="dev-note"></a>
### 开发备注

无。
