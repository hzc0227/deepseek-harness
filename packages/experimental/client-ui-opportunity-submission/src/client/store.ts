/** Per-session form drafts survive composer remounts and client restarts. @author hanzhichao7 */
import { defineStore } from '@deepseek-ai/dsh-client-store'
interface State { valuesByRequest: Record<string, Record<string, string>> }
/**
 * Declare a slot-owned persisted draft store; no module-global instance is retained.
 * @returns The business form's draft store and its complete edit/clear mutation API.
 */
export function createOpportunityFormStore() {
  return defineStore({
    init: (): State => ({ valuesByRequest: {} }), persist: 'dsh.opportunity-form.drafts.v1',
    actions: {
      edit: (state: State, request: string, field: string, value: string) => {
        const values = state.valuesByRequest[request] ?? {}
        values[field] = value
        state.valuesByRequest[request] = values
      },
      clear: (state: State, request: string) => {
        state.valuesByRequest = Object.fromEntries(Object.entries(state.valuesByRequest).filter(([key]) => key !== request))
      },
    },
  })
}
