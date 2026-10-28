/** Business-only complete form, selected ahead of the generic question composer. @author hanzhichao7 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { matchFields, type MatchedField } from './form.ts'
import { OpportunityForm } from './OpportunityForm.tsx'
import { createOpportunityFormStore } from './store.ts'
import { en, zh, type FormKey } from './locales.ts'

/** Exact pending request and field identities consumed by the form. */
export interface OpportunityFormMatch { pending: PendingQuestion; fields: MatchedField[] }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the complete opportunity submission form. */
    opportunityForm: FormKey
  }
}
/** Required presentation services; question transport remains owned by the standard question plugin. */
export const inject = ['slots', 'locale']
/**
 * Mount one business-specific composer using standard controls and the existing question answer channel.
 * @param ctx - Client locale and slot registries.
 * @returns Nothing; registrations unwind with the Cordis plugin.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('opportunityForm', { zh, en }), 'opportunity-form: dictionaries')
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -100, locale: 'opportunityForm', store: createOpportunityFormStore(),
    select: ({ pendingInteraction }: ComposerChainProps): OpportunityFormMatch | null => {
      if (pendingInteraction?.kind !== 'question') return null
      const fields = matchFields(pendingInteraction.questions)
      return fields === null ? null : { pending: pendingInteraction, fields }
    },
  }, OpportunityForm))
}
