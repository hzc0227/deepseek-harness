/** Complete-form request matching, time conversion and isolated persisted drafts. @author hanzhichao7 */
import { describe, expect, it, vi } from 'vitest'
import { FORM_FIELDS, formAnswers, localDeadline, matchFields } from '../src/client/form.ts'
import { createOpportunityFormStore } from '../src/client/store.ts'

/** Create only synthetic field suggestions, retaining the real request id convention. */
function questions() {
  return FORM_FIELDS.map(key => ({ id: `opportunity-form-12-${key}`, question: key, options: [{ label: key }] }))
}

describe('complete opportunity submission form', () => {
  it('matches all six fields by identity and rejects unrelated, incomplete and mixed revision batches', () => {
    const request = questions()
    expect(matchFields([...request].reverse())?.map(field => field.key)).toEqual(FORM_FIELDS)
    expect(matchFields(request.slice(1))).toBeNull()
    expect(matchFields(request.map((row, index) => index === 1 ? request[0]! : row))).toBeNull()
    expect(matchFields(request.map((row, index) => index === 1 ? { ...row, id: 'opportunity-form-13-projectName' } : row))).toBeNull()
    expect(matchFields(request.map(row => ({ ...row, id: `another-${row.id}` })))).toBeNull()
  })

  it('encodes every edited field and round-trips a local deadline without treating suggestions as answers', () => {
    const fields = matchFields(questions())!
    const date = new Date(2030, 5, 15, 14, 30)
    const local = localDeadline(date.toISOString())
    const values = { contractNumber: 'VSP-20300101000001', projectName: '手动填写', amount: '2.5',
      purchaseMode: '6-1', quoteDeadline: local, brandReplaceable: '不允许替代品牌' }
    const answer = formAnswers(fields, values)
    expect(answer.answers).toHaveLength(6)
    expect(answer.answers.every(row => row.selected.length === 0)).toBe(true)
    expect(answer.answers.map(row => row.custom)).toEqual([
      values.contractNumber, values.projectName, values.amount, values.purchaseMode, date.toISOString(), values.brandReplaceable,
    ])
    expect(localDeadline('invalid-date')).toBe('')
    expect(() => formAnswers(fields, { ...values, quoteDeadline: '' })).toThrow()
  })

  it('restores drafts within their session and request and clears only the submitted form', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    try {
      const first = createOpportunityFormStore().create('opportunity-session')
      first.actions.edit('form:one', 'projectName', '我的商机')
      first.actions.edit('form:two', 'amount', '5')
      const restored = createOpportunityFormStore().create('opportunity-session')
      expect(restored.getSnapshot().valuesByRequest['form:one']).toEqual({ projectName: '我的商机' })
      expect(createOpportunityFormStore().create('another-session').getSnapshot().valuesByRequest).toEqual({})
      restored.actions.clear('form:one')
      expect(restored.getSnapshot().valuesByRequest).toEqual({ 'form:two': { amount: '5' } })
    } finally { vi.unstubAllGlobals() }
  })
})
