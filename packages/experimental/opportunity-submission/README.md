---
description: "Local procurement files, durable five-stage opportunity submission, and a standard DSH expert connected to an authenticated enterprise service."
kind: "package-bundle"
---

# Opportunity submission

English | [中文](README.zh.md)

## Summary

This opt-in bundle adds the **商机提报专家** preset, the `opportunity-submission` skill, and six business tools to the standard desktop or Web application. It reads local XLSX and UTF-8 CSV procurement files, preserves source-row identities, checks materials, completes required attributes, prefills the opportunity, and requests explicit human confirmation before submission. Authoritative local tasks use DSH storage; enterprise authentication, recognition, and submission remain server-owned.

## Table of Contents

- [Use the bundle](#use-the-bundle)
- [Business execution](#business-execution)
- [Verification](#verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-the-bundle"></a>
## Use the bundle

Mount `cordis.patch.yml` after a standard application profile. `LINGXI_API_BASE_URL` selects the existing business API origin; omission permits local import only. `LINGXI_AUTHORIZATION` resolves through DSH credentials per request and contains an existing short-lived Bearer authorization for `lingxi-submit`. All five operations use their existing `/nova-api/` routes. The desktop supplies the required forwarding headers from that token; the business server verifies its signature and authority. A DSH model login or a client-supplied ERP is not business authorization, and this plugin never loads a signing private key.

Select **商机提报专家**, or ask the default assistant to use the advertised skill. Supply a local file path and any known opportunity fields. The standard DSH conversation, tool results, and user-question mechanism carry the interaction; no custom Client plugin is installed. Local source files are not uploaded; structured materials still travel to the enterprise service for recognition and submission.

Configuration owns file/row limits, recognition batch size, HTTP deadline, response ceiling, preview size, and business defaults. The default amount is **1 ten-thousand yuan**, purchase mode `4-4`, quotation deadline seven days after import, and alternative brands allowed. These are reviewable defaults, never invented material facts. The source customer number and explicit user form values take precedence; enterprise prefill may replace provisional amount, name, and deadline, but never explicit user values.

<a id="business-execution"></a>
## Business execution

| Tool | Behavior |
|---|---|
| `opportunity_start` | Read a local file through DSH filesystem policy; locate the real table header and customer metadata; save one task for the calling session. |
| `opportunity_status` | Read durable progress, editable form, bounded material sample, and unresolved fields. |
| `opportunity_advance` | Run detection, required-attribute completion, or prefill; keep an uncertain submission blocked for verification in the business system. |
| `opportunity_refill` | Batch-fill unchecked or incomplete valid materials in one action; preserve source values, user values, and the current stage, and retain missing values as notices. |
| `opportunity_update` | Apply explicit user corrections by source-row ID and invalidate dependent checks. |
| `opportunity_submit` | Open the complete six-field form on one page; submit human-entered or selected values directly, without another confirmation; persist state before sending and require a real opportunity number. |

The phases are `detect → complete → prefill → ready → submitted`. An interrupted submit stays `submitting` or `unknown`; neither phase can be edited, replaced, or automatically resubmitted. Each successful read-only batch is saved before the next batch. Failed batches can be repeated; completed batches remain available after desktop restart. Concurrent operations for one session are rejected. Another session cannot select or read the owner's task through tool arguments.

The plugin calls existing POST APIs directly: `/nova-api/onepage/material/category-brand/recognize`, `/nova-api/onepage/material/invalid/check`, `/nova-api/aiRecognition/materials/recognize`, `/nova-api/opportunity/prefill/query`, and `/nova-api/oppo/direct/submit`. Installing this bundle changes the local DSH composition; business services remain external dependencies. Responses use `{code:0,data:...}`; the direct-submit API returns the opportunity number as `data` string. Forwarding headers are derived only from an existing signed credential, whose authenticity remains the business server's responsibility.

The existing API retains legacy source field names but uses them only for tracing. For local files, `source.pageId` is a content-addressed `urn:sha256:` identifier computed from the actual file bytes; `source.sheetId` identifies the persisted `dsh-materials:` task collection. `snapshotVersion` records the confirmed revision and `originalFileName` preserves the input basename. The current submit validator checks these references for presence and does not read an external worksheet. The local identifiers do not claim that a JoySpace document exists.

Recognition results must match the complete requested ID set, regardless of result order. Explicit invalid materials are excluded. A missing aggregate validity decision (`isInvalidOppo`) rejects the response; supplementary non-supply and risk-vendor flags may be absent, and returned invalid reasons remain visible. Nullable descriptive fields remain unknown. Required attributes cannot be satisfied by placeholders such as `无`. Automatic filling persists real recognized values; unresolved fields remain notices and do not block prefill, confirmation, or submission, or exclude otherwise valid rows. `blockingIssueCount` counts errors that actually prevent submission separately. User edits to source fields restart dependent checks; edits to confirmed attributes preserve other source data. The final step uses the complete single-page form using standard DSH controls, with parsed values and defaults offered only as suggestions. The human supplies customer master data, name, amount in ten-thousand yuan, purchase mode, deadline, and brand replacement; submitting the form calls the business API without another confirmation. The form displays material scope and unfilled notices and requires valid values for all six fields; all six fields appear together, with a numeric amount, dropdowns for purchase mode and alternative brands, and a local date/time picker. Cancel never creates an opportunity. Drafts are isolated by Session and request and survive switching Sessions or reopening the same panel. Changing brand replacement reruns material checks; a changed material scope requires reviewing the form again.

<a id="verification"></a>
## Verification

Package tests use synthetic local procurement workbooks and a loopback enterprise fixture, with isolated durable storage and standard DSH interaction. The recorded-session scenario is [opportunity-submission](../../../snapshots/session/opportunity-submission/snapshot.yml). Real enterprise deployment, SSO, downstream permissions, and formal business creation require separate environment verification; fixture success does not establish those outcomes.

<a id="dev-note"></a>
## Dev Note

None.

<a id="model-experience"></a>
## Model Experience

### Business tools and task facts

#### What the model sees

Six `opportunity_*` tool schemas, canonical progress and form values, bounded material samples and issues, explicit defaults, and a real opportunity number only after confirmed success. Raw source bytes, complete recognition batches, credentials, and signing keys are not returned to the model.

#### Token effect

Tool schemas are retained while the bundle is mounted. Each invocation appends its bounded result. The full material dataset stays in local task storage rather than being repeated in every model request.

#### KV Cache effect

Stable tool schemas preserve an otherwise reusable prefix. Tool results append task-dependent history; changing bundle configuration, schema text, or the selected preset can invalidate the affected request prefix.

### On-demand business skill

#### What the model sees

The skill catalog description routes local-file opportunity requests to [the packaged skill](assets/opportunity-submission/SKILL.md). Its body is loaded only when invoked and owns the model's business procedure.

#### Token effect

The short catalog entry is advertised; loading the skill appends its instructions to the session. Business state and authority remain in tools and storage.

#### KV Cache effect

The catalog is stable while this plugin remains mounted. Skill loading appends instructions; editing the packaged skill changes the subsequently loaded instruction text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Existing business access** — the business endpoint and existing Nova-protocol authorization must be available. The DSH model account grants none of these enterprise permissions.
- **Input formats** — XLSX and UTF-8 CSV are supported. Images and legacy binary XLS need a separate local decoder and are rejected instead of silently misparsed.
- **Local continuity** — task progress survives restart on the same DSH storage. Cross-machine synchronization and arbitrary task branching are not provided.
- **Uncertain external writes** — the existing direct-submit API exposes no per-task idempotency or status query. A local record cannot guarantee exactly-once creation; an uncertain outcome remains blocked and requires business-system verification.
