---
description: "Edit all opportunity submission fields on one page using standard DSH controls."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-opportunity-submission

English | [中文](README.zh.md)

## Summary

Review and edit customer master data, opportunity name, amount, purchase mode, quotation deadline, and alternative-brand requirements together. Submit opportunity sends the completed form directly through the business tool. Cancel leaves the task unchanged.

## Table of Contents

- [Usage](#usage)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="usage"></a>
## Usage

The [opportunity submission bundle](../opportunity-submission/README.md) mounts this optional browser plugin. Parsed and suggested values appear in editable controls. The amount is in CNY 10,000, and the deadline picker displays local time. The form uses numeric and text inputs, dropdowns, and one submit button. The supporting section preserves material scope and unresolved attribute notices. Missing attributes do not block submission; the Host validates the final form and requires an actual business opportunity number before reporting success.

<a id="implementation"></a>
## Implementation

The plugin registers a business-specific entry before the generic question composer. It matches only the complete revision-bound opportunity field batch, retains the standard human-answer transport, and leaves unrelated question requests unchanged. Session-scoped drafts preserve edits across composer remounts. Submission disables repeated clicks; transport failures retain editable values and display the error. The Host owns authenticated business calls and uncertain outcomes. The browser never receives business authorization credentials.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-experimental-opportunity-submission`, whose field questions this package presents as one complete form.

#### KV Cache effect

No direct invalidation; `dsh-experimental-opportunity-submission` owns model-visible tool inputs and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The complete form requires the Desktop or Web client plugin. Other clients retain their standard multi-question presentation. Drafts are local to the current Client and Session; they do not synchronize between devices.

<a id="dev-note"></a>
### Dev Note

None.
