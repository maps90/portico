// Azure Container App for omni-mcp.
//
// Assumes these already exist (create once per environment, outside this file):
//   - a Container Apps managed Environment (environmentId)
//   - an Azure Container Registry holding the image (acrLoginServer + image)
//   - a user-assigned managed identity with AcrPull on the registry, Key Vault
//     Secrets User on the vault, and Storage Blob Data Contributor on the
//     artifact storage account (managedIdentityId)
//   - a Key Vault holding the secrets referenced below (keyVaultUri)
//   - Azure Database for PostgreSQL and a private Blob container
//
// Secrets are pulled from Key Vault by reference — never baked into the image
// or this template. Non-secret config is passed as plain env vars.

@description('Deployment location')
param location string = resourceGroup().location

@description('Container app name')
param name string = 'omni-mcp'

@description('Resource id of the Container Apps managed environment')
param environmentId string

@description('Full image reference, e.g. myacr.azurecr.io/omni-mcp:1.0.0')
param image string

@description('ACR login server, e.g. myacr.azurecr.io')
param acrLoginServer string

@description('Resource id of the user-assigned managed identity')
param managedIdentityId string

@description('Key Vault URI, e.g. https://omni-kv.vault.azure.net/')
param keyVaultUri string

@description('Public base URL, e.g. https://omni.okadoc.com')
param baseUrl string

@description('Okadoc Entra tenant id')
param entraTenantId string

@description('Entra app (client) id')
param entraClientId string

@description('Artifact storage account name')
param artifactBlobAccount string

@description('Artifact blob container name')
param artifactContainer string = 'omni-artifacts'

@description('Min / max replicas')
param minReplicas int = 1
param maxReplicas int = 5

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: managedIdentityId
        }
      ]
      secrets: [
        { name: 'database-url', keyVaultUrl: '${keyVaultUri}secrets/omni-database-url', identity: managedIdentityId }
        { name: 'encryption-key', keyVaultUrl: '${keyVaultUri}secrets/omni-encryption-key', identity: managedIdentityId }
        { name: 'session-secret', keyVaultUrl: '${keyVaultUri}secrets/omni-session-secret', identity: managedIdentityId }
        { name: 'entra-client-secret', keyVaultUrl: '${keyVaultUri}secrets/omni-entra-client-secret', identity: managedIdentityId }
        // Add one secret per configured upstream, e.g.:
        // { name: 'upstream-atlassian-client-secret', keyVaultUrl: '${keyVaultUri}secrets/omni-upstream-atlassian-client-secret', identity: managedIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'OMNI_BASE_URL', value: baseUrl }
            { name: 'OMNI_PORT', value: '8080' }
            { name: 'OMNI_ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'OMNI_ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'OMNI_ARTIFACT_BLOB_ACCOUNT', value: artifactBlobAccount }
            { name: 'OMNI_ARTIFACT_CONTAINER', value: artifactContainer }
            { name: 'OMNI_DATABASE_URL', secretRef: 'database-url' }
            { name: 'OMNI_ENCRYPTION_KEY', secretRef: 'encryption-key' }
            { name: 'OMNI_SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'OMNI_ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
            // Upstream creds (ids are non-secret env, secrets via secretRef):
            // { name: 'OMNI_UPSTREAM_ATLASSIAN_CLIENT_ID', value: '...' }
            // { name: 'OMNI_UPSTREAM_ATLASSIAN_CLIENT_SECRET', secretRef: 'upstream-atlassian-client-secret' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 15 }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 15 }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
