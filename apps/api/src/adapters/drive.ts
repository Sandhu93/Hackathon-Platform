import type { AppConfig } from '@hackathon/shared';
import { ConfigError } from '../lib/errors';

/**
 * PROVISIONAL contract. Milestone 06 finalises it (resumable uploads, verification,
 * quotas). Milestone 00 only needs a mock that proves the seam exists.
 */
export interface DriveFolder {
  id: string;
  path: string[];
}

export interface DriveFile {
  id: string;
  folderId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DriveStorageAdapter {
  readonly name: string;
  ensureFolder(path: string[]): Promise<DriveFolder>;
  putFile(input: {
    folderId: string;
    name: string;
    mimeType: string;
    data: Uint8Array;
  }): Promise<DriveFile>;
  getFile(id: string): Promise<DriveFile | null>;
  deleteFile(id: string): Promise<void>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeSegment(segment: string): void {
  if (!SAFE_SEGMENT.test(segment) || segment.includes('..')) {
    throw new Error('Unsafe folder or file name');
  }
}

/** Adapter methods are async: validation failures must surface as rejected promises. */
function validateSegments(segments: string[]): Error | null {
  try {
    segments.forEach(assertSafeSegment);
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** In-memory stand-in for Google Drive (per Worker isolate). Never used in production. */
export class MockDriveStorageAdapter implements DriveStorageAdapter {
  readonly name = 'mock';
  private readonly folders = new Map<string, DriveFolder>();
  private readonly files = new Map<string, DriveFile>();
  private seq = 0;

  ensureFolder(path: string[]): Promise<DriveFolder> {
    const invalid = validateSegments(path);
    if (invalid) return Promise.reject(invalid);
    const key = path.join('/');
    let folder = this.folders.get(key);
    if (!folder) {
      this.seq += 1;
      folder = { id: `mock-folder-${this.seq}`, path: [...path] };
      this.folders.set(key, folder);
    }
    return Promise.resolve(folder);
  }

  putFile(input: {
    folderId: string;
    name: string;
    mimeType: string;
    data: Uint8Array;
  }): Promise<DriveFile> {
    const invalid = validateSegments([input.name]);
    if (invalid) return Promise.reject(invalid);
    if (![...this.folders.values()].some((f) => f.id === input.folderId)) {
      return Promise.reject(new Error('Unknown folder'));
    }
    this.seq += 1;
    const file: DriveFile = {
      id: `mock-file-${this.seq}`,
      folderId: input.folderId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
    };
    this.files.set(file.id, file);
    return Promise.resolve(file);
  }

  getFile(id: string): Promise<DriveFile | null> {
    return Promise.resolve(this.files.get(id) ?? null);
  }

  deleteFile(id: string): Promise<void> {
    this.files.delete(id);
    return Promise.resolve();
  }
}

export interface DriveSecrets {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string | undefined;
}

/** Fails closed like the email factory. The Google adapter is built in Milestone 06. */
export function createDriveStorage(config: AppConfig, secrets: DriveSecrets): DriveStorageAdapter {
  if (config.DRIVE_PROVIDER === 'mock') {
    if (config.ENVIRONMENT === 'production') {
      throw new ConfigError('DRIVE_PROVIDER=mock is not allowed in production');
    }
    return new MockDriveStorageAdapter();
  }
  if (!secrets.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new ConfigError('GOOGLE_SERVICE_ACCOUNT_JSON is required when DRIVE_PROVIDER=google');
  }
  throw new ConfigError('DRIVE_PROVIDER=google is not implemented yet (Milestone 06)');
}
