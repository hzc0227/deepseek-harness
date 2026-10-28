/** All opportunity fields on one panel; only a human form submission settles the business request. @author hanzhichao7 */
import { useState, type FormEvent } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { OpportunityFormMatch } from './index.ts'
import { formAnswers, localDeadline } from './form.ts'
import type { createOpportunityFormStore } from './store.ts'
import css from './Form.module.css'

/** Complete framework-derived props and the business selector's narrowed request. */
type Props = PropsRuntime<'conversation.composer'> & PropsLocale<'opportunityForm'>
  & PropsStore<ReturnType<typeof createOpportunityFormStore>>
  & { matched: OpportunityFormMatch }

/**
 * Key the component by its exact pending request so local submission state never leaks between forms.
 * @param props - Slot-owned draft, locale, request, and reactive card seats.
 * @returns The full form for this one request.
 */
export function OpportunityForm(props: Props) {
  return <Form key={props.matched.pending.key} {...props} />
}

/**
 * Render six simultaneously editable controls and submit the answer batch once.
 * @param props - Exact request, persisted draft actions, locale and reactive request state.
 * @returns The complete form panel; failures leave fields editable and never claim business success.
 */
function Form({ matched: { pending, fields }, t, useStore, actions }: Props) {
  const saved = useStore(value => value.valuesByRequest[pending.key])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const disabled = busy || pending.review !== undefined
  const recorded = new Map((pending.review ?? []).map(answer => [answer.id, answer]))
  const values = Object.fromEntries(fields.map(({ key, question }) => {
    const answer = recorded.get(question.id)
    const suggestion = answer?.custom ?? answer?.selected[0] ?? question.options?.[0]?.label ?? ''
    const value = key === 'quoteDeadline' ? localDeadline(suggestion) : suggestion
    return [key, pending.review === undefined ? saved?.[key] ?? value : value]
  }))

  /** Settle only the existing human answer channel; business dispatch remains with the Host tool. */
  const send = async (cancel: boolean): Promise<void> => {
    if (disabled) return
    if (pending.snapshot().closed || pending.snapshot().channel === 'none') { setError(t('unavailable')); return }
    setBusy(true)
    setError('')
    try {
      await pending.answer(cancel ? { answers: [] } : formAnswers(fields, values))
      actions.clear(pending.key)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unavailable'))
      setBusy(false)
    }
  }
  /** Native field validation runs before converting the complete human draft into wire answers. */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!event.currentTarget.reportValidity()) { setError(t('incomplete')); return }
    void send(false)
  }

  return <div className={css.frame}>
    <form className={css.card} aria-label={t('title')} aria-busy={busy} onSubmit={submit}>
      <header className={css.header}><h3>{t('title')}</h3><p>{t('hint')}</p></header>
      <div className={css.body}>
        <div className={css.grid}>
          {fields.map(({ key, question }) => {
            const id = `${pending.key}-${key}`
            const select = key === 'purchaseMode' || key === 'brandReplaceable'
            return <label className={css.field} key={key} htmlFor={id}>
              <span>{t(key)}</span>
              {select ? <select id={id} value={values[key]} disabled={disabled} required
                onChange={(event) => { actions.edit(pending.key, key, event.target.value) }}>
                {(question.options ?? []).map(option => <option key={option.label} value={option.label}>
                  {option.description ?? option.label}
                </option>)}
              </select> : <Input id={id} value={values[key]} disabled={disabled} required
                type={key === 'amount' ? 'number' : key === 'quoteDeadline' ? 'datetime-local' : 'text'}
                {...(key === 'amount' ? { min: 0.0001, step: 0.0001 } : {})}
                {...(key === 'projectName' ? { maxLength: 100 } : {})}
                onChange={(event) => { actions.edit(pending.key, key, event.target.value) }} />}
            </label>
          })}
        </div>
        {fields[0]?.question.detail && <details className={css.detail}><summary>{t('scope')}</summary>
          <p>{fields[0].question.detail}</p></details>}
      </div>
      <footer className={css.footer}>
        <span className={css.error} role="alert">{error}</span>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => { void send(true) }}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={disabled}>{busy ? t('submitting') : t('submit')}</Button>
      </footer>
    </form>
  </div>
}
