import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { ArtifactStore } from "../../ports/artifacts.js";

export interface AzureBlobConfig {
  blobAccount: string;
  container: string;
  connectionString?: string;
}

/**
 * ArtifactStore over Azure Blob Storage. Uses a connection string when provided,
 * otherwise DefaultAzureCredential (managed identity in AKS/Container Apps). The
 * container is private; bytes are streamed to viewers by the `/visual/:id` route, so
 * no public/presigned access is ever granted.
 */
export class AzureBlobArtifactStore implements ArtifactStore {
  private readonly container: ContainerClient;

  constructor(cfg: AzureBlobConfig) {
    const service = cfg.connectionString
      ? BlobServiceClient.fromConnectionString(cfg.connectionString)
      : new BlobServiceClient(
          `https://${cfg.blobAccount}.blob.core.windows.net`,
          new DefaultAzureCredential(),
        );
    this.container = service.getContainerClient(cfg.container);
  }

  async put(ref: string, body: Buffer, contentType: string): Promise<void> {
    const blob = this.container.getBlockBlobClient(ref);
    await blob.uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  async get(ref: string): Promise<Buffer | null> {
    const blob = this.container.getBlockBlobClient(ref);
    try {
      return await blob.downloadToBuffer();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async delete(ref: string): Promise<void> {
    await this.container.getBlockBlobClient(ref).deleteIfExists();
  }
}
