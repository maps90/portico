# Deploying portico to Azure (Okadoc)

portico ships as a single container. This guide targets **Azure Container Apps**
with **Entra** identity, **Azure Database for PostgreSQL**, **Azure Blob Storage**
for artifacts, and **Key Vault** for secrets. (AKS works too — the container and
env vars are identical; deploy it as a Deployment + Service + Ingress and mount
the same secrets.)

## 0. One-time Azure resources

| Resource | Notes |
|---|---|
| Resource group | e.g. `portico-rg` |
| Azure Container Registry (ACR) | holds the image |
| Container Apps Environment | with a Log Analytics workspace |
| User-assigned managed identity | grant it: **AcrPull** on ACR, **Key Vault Secrets User** on the vault, **Storage Blob Data Contributor** on the artifact storage account |
| Key Vault | holds the secrets in step 3 |
| Azure Database for PostgreSQL (Flexible Server) | create a database `portico`; note the connection string |
| Storage account + **private** Blob container `portico-artifacts` | no public access |

## 1. Entra app registration (identity)

1. Register an app in the **Okadoc** Entra tenant. Set it **single-tenant**
   (accounts in this org only) — this is what restricts login to Okadoc.
2. Add a **Web** redirect URI: `https://<your-domain>/auth/entra/callback`.
3. Create a client secret → store it in Key Vault (step 3).
4. Note the **Directory (tenant) ID** and **Application (client) ID**.

## 2. Upstream OAuth apps (per service you enable)

For each upstream (Atlassian, Google, GitHub, …) register an OAuth app with its
vendor and add the redirect URI `https://<your-domain>/connect/<id>/callback`
(e.g. `/connect/atlassian/callback`). Put each client id in env and each client
secret in Key Vault. Also set `PORTICO_UPSTREAM_<ID>_MCP_URL` to the vendor's remote
MCP endpoint where the built-in default is empty or differs.

## 3. Key Vault secrets

Generate and store (names must match `containerapp.bicep`):

```bash
az keyvault secret set --vault-name portico-kv --name portico-database-url        --value "postgresql://USER:PASS@HOST:5432/portico?sslmode=require"
az keyvault secret set --vault-name portico-kv --name portico-encryption-key      --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name portico-kv --name portico-session-secret      --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name portico-kv --name portico-entra-client-secret --value "<entra client secret>"
# per upstream, e.g.:
az keyvault secret set --vault-name portico-kv --name portico-upstream-atlassian-client-secret --value "<...>"
```

`PORTICO_ENCRYPTION_KEY` must be a base64-encoded **32 bytes** (AES-256). Rotating it
makes existing vault-stored upstream tokens undecryptable (users re-connect).

## 4. Build & push the image

```bash
az acr build --registry <acr-name> --image portico:1.0.0 .
```

## 5. Deploy

```bash
az deployment group create \
  --resource-group portico-rg \
  --template-file deploy/containerapp.bicep \
  --parameters \
     environmentId=<container-apps-env-resource-id> \
     image=<acr>.azurecr.io/portico:1.0.0 \
     acrLoginServer=<acr>.azurecr.io \
     managedIdentityId=<user-assigned-mi-resource-id> \
     keyVaultUri=https://portico-kv.vault.azure.net/ \
     baseUrl=https://<your-domain> \
     entraTenantId=<okadoc-tenant-id> \
     entraClientId=<entra-client-id> \
     artifactBlobAccount=<storage-account-name>
```

Map `baseUrl`'s domain to the app's ingress FQDN (output `fqdn`) via a CNAME +
Container Apps custom domain + managed certificate. `PORTICO_BASE_URL` **must** equal
the public URL — it builds the OAuth redirect URIs and artifact links.

## 6. Post-deploy checks

```bash
curl https://<your-domain>/healthz     # {"status":"ok"}
curl https://<your-domain>/readyz      # {"status":"ready","db":"ok"}
```

Then open `https://<your-domain>/login` in a browser, sign in with an Okadoc
account, copy the bearer token, and give it to Jean (see `docs/jean-integration.md`).

## Notes

- The DB schema is created idempotently at boot (`ensureSchema`); no migration
  step is required for the initial deploy.
- Artifact bytes are streamed through the app from the **private** Blob container;
  the container must never be given public or anonymous access.
- Scale is stateless — increase `maxReplicas` freely; all state is in Postgres/Blob.
