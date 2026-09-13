# Workspace API contract

The extension treats every endpoint here as optional. A missing workspace
service must not prevent normal profile autofill. All requests use the
configured local API base — extension storage key `autoapplyApiBase`, default
`http://127.0.0.1:8000`, editable in the popup's **Backend** field — and JSON
unless stated otherwise.

## Opportunity and policy context

`POST /api/workspace/opportunities/upsert`

```json
{
  "url": "https://jobs.example/apply/123",
  "company": "Example",
  "role": "Software Engineer",
  "platform": "greenhouse",
  "page_title": "Software Engineer - Example",
  "job_description_snippet": "...",
  "source": "browser_extension",
  "duplicate_resolution": "reuse",
  "existing_id": "opp_existing"
}
```

Returns `{ "opportunity": { "id": "opp_..." } }` (or `{ "opportunity_id": "..." }`).
Before upsert, `GET /api/workspace/duplicates?url=...&company=...&role=...`
returns exact URL or likely company/role matches with `match_type` and
`match_reason`. The caller must explicitly choose `reuse` with an existing ID
or `create_new`; records are never merged or deleted automatically.

`GET /api/workspace/policy?url=<encoded>&platform=<encoded>` returns either a
policy object or `{ "policy": { ... } }`. The currently consumed fields are
`allow_autopilot` (boolean), `message`, and `reason`. `allow_autopilot: false`
disables AutoPilot; it never authorizes automatic submission.

## Resume versions and attachment

`GET /api/workspace/resume-versions` returns

```json
{
  "versions": [
    { "id": "resume_...", "label": "Backend-focused", "filename": "resume.pdf", "active": true }
  ]
}
```

`GET /api/workspace/resume-versions/{id}/download` returns the selected resume
as bytes, with `Content-Type` and preferably a `Content-Disposition` filename.
The background script downloads no more than 10 MiB, then the content script
uses `File` + `DataTransfer` to attach it to a native file input. Browsers or
sites that reject this operation show a manual-file fallback instead.

## Packets, recovery teaches, and receipts

`POST /api/workspace/application-packets` receives

```json
{
  "opportunity_id": "opp_...",
  "resume_version_id": "resume_...",
  "stage": "review",
  "page_url": "https://jobs.example/apply/123",
  "instructions": [],
  "field_failures": []
}
```

It returns `{ "packet": { "id": "packet_..." } }` (or `{ "packet_id": "..." }`).

`POST /api/workspace/teaches` captures only a user correction or a recovery
attempt: `opportunity_id`, optional `packet_id`, `url`, `field` (`id`, `label`,
`type`), `proposed_value`, `corrected_value`, and `failure_reason`.

`POST /api/workspace/submissions/confirm` is called only after the user clicks
the extension’s **Record submission** button on a confirmation page and
confirms the dialog. It
receives `opportunity_id`, `packet_id`, `submitted_at`, `user_confirmed: true`,
and a non-authoritative page receipt (`url`, `title`, `confirmation_text`). It
returns an optional `{ "receipt": { "id": "receipt_..." } }`.

The extension contains no endpoint or code path that clicks an employer submit
control.

## Workspace reads and follow-ups

`GET /api/workspace/opportunities` accepts optional `status`, `search`, `sort`,
and `limit` query parameters. `GET /api/workspace/overview` returns summary
metrics, prioritized actions, upcoming interviews, recent activity, and the
reusable assets needed by the dashboard.

`GET /api/workspace/applications/{id}/packet` returns the canonical
opportunity, latest packet, selected resume, prepared answers, fill failures,
receipt, contacts, follow-ups, and interviews. Follow-ups can be completed or
rescheduled with `PATCH /api/workspace/follow-ups/{id}`.

The legacy `/api/applications` routes remain available: canonical writes are
mirrored into them, and the dashboard keeps them as an always-on fallback —
`GET /api/applications/?limit=500` replaces a failed workspace read (shown as
"History fallback") instead of blanking every panel.
