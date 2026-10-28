/** Opaque identifiers shared by durable tasks and enterprise requests. @author hanzhichao7 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One local task identity, independently of its owning DSH session. */
export type OpportunityTaskId = Branded<'OpportunityTaskId'>
/** Local identity of one logical submission attempt, retained for manual verification after interruption. */
export type OpportunitySubmissionKey = Branded<'OpportunitySubmissionKey'>
/** Physical source row identity retained across enterprise recognition batches. */
export type OpportunityRowId = Branded<'OpportunityRowId'>
