/** Pure field matching and answer encoding for the business-owned form. @author hanzhichao7 */
import type { AskUserQuestionItem, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'

/** The complete editable business form; these keys match the Host's field questions. */
export const FORM_FIELDS = ['contractNumber', 'projectName', 'amount', 'purchaseMode', 'quoteDeadline', 'brandReplaceable'] as const
/** One known field in the opportunity submission form. */
export type FormField = typeof FORM_FIELDS[number]
/** A field paired with the exact revision-bound question it answers. */
export interface MatchedField { key: FormField; question: AskUserQuestionItem }

/**
 * Match only this plugin's complete six-field request; unrelated question flows retain their existing UI.
 * @param questions - Current request's complete question batch.
 * @returns The ordered fields, or null for incomplete, mixed-revision, or unrelated requests.
 */
export function matchFields(questions: readonly AskUserQuestionItem[]): MatchedField[] | null {
  if (questions.length !== FORM_FIELDS.length) return null
  const revision = questions[0]?.id.match(/^opportunity-form-([0-9]+)-/u)?.[1]
  if (revision === undefined) return null
  const fields: MatchedField[] = []
  for (const key of FORM_FIELDS) {
    const question = questions.find(item => item.id === `opportunity-form-${revision}-${key}`)
    if (question === undefined) return null
    fields.push({ key, question })
  }
  return fields
}

/**
 * Display the existing deadline in the user's local date/time control without changing its instant.
 * @param value - ISO timestamp suggested by the business service.
 * @returns A local datetime input value, or empty text for an invalid suggestion.
 */
export function localDeadline(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Encode all visible field values as human answers; only the deadline is converted from local time to ISO.
 * @param fields - Exact Host question identities matched for the current revision.
 * @param values - Current text/control values, including explicit edits and selected suggestions.
 * @returns One answer per field, ready for the existing user-question transport.
 */
export function formAnswers(fields: readonly MatchedField[], values: Record<string, string>): AskUserQuestionAnswer {
  return { answers: fields.map(({ key, question }) => ({ id: question.id, selected: [],
    custom: key === 'quoteDeadline' ? new Date(values[key] ?? '').toISOString() : values[key] ?? '',
  })) }
}
