/** Complete opportunity-form labels owned by the business plugin. @author hanzhichao7 */
export const zh = {
  scope: '查看物料范围和未回填提示', title: '商机提交表单', submit: '提交商机', submitting: '正在提交…', cancel: '暂不提交',
  contractNumber: '客户主数据号', projectName: '商机名称', amount: '商机金额（万元）',
  purchaseMode: '采购模式', quoteDeadline: '报价截止时间', brandReplaceable: '品牌替代要求',
  hint: '请核对并填写以下信息，点击“提交商机”后直接提交。', unavailable: '表单已关闭，请重新打开后填写。',
  incomplete: '请填写全部字段并核对日期和金额。',
} satisfies Record<string, string>
/** The typed copy keys used by the complete form. */
export type FormKey = keyof typeof zh
/** English counterpart with the same field and feedback keys. */
export const en: Record<FormKey, string> = {
  scope: 'Material scope and unfilled fields', title: 'Submit opportunity', submit: 'Submit opportunity', submitting: 'Submitting…', cancel: 'Cancel',
  contractNumber: 'Customer master data', projectName: 'Opportunity name', amount: 'Amount (CNY 10,000)',
  purchaseMode: 'Purchase mode', quoteDeadline: 'Quotation deadline', brandReplaceable: 'Alternative brands',
  hint: 'Review and complete all fields. Submit opportunity creates the opportunity directly.',
  unavailable: 'This form is closed. Open it again to continue.', incomplete: 'Complete all fields and check the date and amount.',
}
