# Builtin providers — setup

## Google (new OAuth client, serves both `gdrive__*` and `gdocs__*`)
One client, one consent, one stored token — the `google-drive` connection carries
both tool sets.

1. Google Cloud console → enable **all four**: Google Drive API, **Google Sheets
   API**, **Google Slides API**, Google Docs API. Sheets and Slides are separate
   services that no Drive scope reaches, so enabling only Drive is the failure that
   looks like it works: `gdrive__search_files` succeeds and every
   `gdrive__read_sheet` returns 403.
2. Credentials → Create OAuth client ID → Web application (`portico google-drive`).
3. Redirect URIs: `https://portico.int.okadoc.net/connect/google-drive/callback`
   and `http://localhost:8080/connect/google-drive/callback`. The path segment is
   the upstream id verbatim, so it stays `google-drive` even though this connection
   also serves the Docs tools.
4. Consent screen (Internal): add scopes `.../auth/documents`, `.../auth/drive.file`,
   `.../auth/drive.readonly`, `.../auth/spreadsheets.readonly`,
   `.../auth/presentations.readonly`. Only `documents` grants writes; the rest are
   read-only.
5. Put the client id/secret in `PORTICO_UPSTREAM_GOOGLE_DRIVE_CLIENT_ID/_SECRET`
   (locally in `.env`; in prod in the flux-infra Vault path
   `infrastructure/admin-v2/portico/vaultstaticsecret.yaml`).

Renaming from `google-docs`: the old `PORTICO_UPSTREAM_GOOGLE_DOCS_*` keys are dead
and can be deleted. Everyone re-links regardless — the scope set changed, so an old
token would not carry the new grants even under the old names.

## Jira (no new setup)
Uses the existing `atlassian` 3LO connection and its granted scopes
(`read:jira-work`, `write:jira-work`, `read:jira-user`, `read:me`). Nothing to add.

## Smoke test (manual, after deploy)
- Connect Google Drive from the portal, then via an MCP client:
  `gdocs__create_document {title}` → `gdocs__append_text {documentId,text}` → `gdocs__get_document {documentId}`.
- Drive/Sheets/Slides on that same connection — this is where a missing API
  enablement shows up, so run all three:
  `gdrive__search_files {q: "mimeType='application/vnd.google-apps.spreadsheet'"}` →
  `gdrive__list_sheets {spreadsheetId}` → `gdrive__read_sheet {spreadsheetId, range: "<tab>!A1:D20"}`,
  then `gdrive__read_presentation {presentationId}` on any deck.
  A 403 on `read_sheet` after `search_files` succeeded means the Sheets API is not
  enabled on the client, not that the scope is missing.
- Paging: `gdrive__search_files` with a small `pageSize` must return a
  `nextPageToken`; feed it back as `pageToken` and confirm page two differs.
- With Atlassian connected: `jira__list_projects` → `jira__search {jql}` → `jira__get_issue {key}`.
- Confirm a bad `jira__search` JQL returns the real Jira error text (not the hosted-MCP generic message).
- Epic parenting, which needs a real epic key:
  `jira__create_issue {project, issueType: "Story", summary, parent: "<EPIC>"}` →
  `jira__get_issue` the new key and confirm `fields.parent` is the epic. Then
  `jira__edit_issue {key, parent: null}` detaches it. `parent` is the right field for
  both company-managed and team-managed projects; a site still on the legacy Epic Link
  custom field goes through `jira__edit_issue {key, fields: {customfield_100xx: "<EPIC>"}}`.
