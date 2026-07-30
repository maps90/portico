# Builtin providers — setup

## Google Docs (new OAuth client)
1. Google Cloud console → enable **Google Docs API** + **Google Drive API**.
2. Credentials → Create OAuth client ID → Web application (`portico google-docs`).
3. Redirect URIs: `https://portico.int.okadoc.net/connect/google-docs/callback`
   and `http://localhost:8080/connect/google-docs/callback`.
4. Consent screen (Internal): add scopes `.../auth/documents`, `.../auth/drive.file`.
5. Put the client id/secret in `PORTICO_UPSTREAM_GOOGLE_DOCS_CLIENT_ID/_SECRET`
   (locally in `.env`; in prod in the flux-infra Vault path
   `infrastructure/admin-v2/portico/vaultstaticsecret.yaml`).

## Jira (no new setup)
Uses the existing `atlassian` 3LO connection and its granted scopes
(`read:jira-work`, `write:jira-work`, `read:jira-user`, `read:me`). Nothing to add.

## Smoke test (manual, after deploy)
- Connect Google Docs from the portal, then via an MCP client:
  `gdocs__create_document {title}` → `gdocs__append_text {documentId,text}` → `gdocs__get_document {documentId}`.
- With Atlassian connected: `jira__list_projects` → `jira__search {jql}` → `jira__get_issue {key}`.
- Confirm a bad `jira__search` JQL returns the real Jira error text (not the hosted-MCP generic message).
- Epic parenting, which needs a real epic key:
  `jira__create_issue {project, issueType: "Story", summary, parent: "<EPIC>"}` →
  `jira__get_issue` the new key and confirm `fields.parent` is the epic. Then
  `jira__edit_issue {key, parent: null}` detaches it. `parent` is the right field for
  both company-managed and team-managed projects; a site still on the legacy Epic Link
  custom field goes through `jira__edit_issue {key, fields: {customfield_100xx: "<EPIC>"}}`.
