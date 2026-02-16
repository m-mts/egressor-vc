import * as vscode from 'vscode';
import { SecretDeclaration } from '../config/types';
import { StoredSecretMetadata, SecretFields } from './types';

/** Key prefix for secret metadata in global state */
const METADATA_KEY = 'egressor.secretMetadata';

/** Key prefix for secret values in SecretStorage */
const SECRET_PREFIX = 'egressor.secret.';

/**
 * Interface for VS Code secret storage, enabling testability.
 */
export interface SecretStorageApi {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

/**
 * Interface for VS Code global state (Memento), enabling testability.
 */
export interface GlobalStateApi {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

/**
 * Manages secret credential storage using VS Code SecretStorage API.
 * Stores secret values securely and provides them to Secretless Broker
 * via file-based credential providers.
 */
export class CredentialProvider implements vscode.Disposable {
    private secretStorage: SecretStorageApi;
    private globalState: GlobalStateApi;
    private outputChannel: vscode.OutputChannel;

    constructor(
        secretStorage: SecretStorageApi,
        globalState: GlobalStateApi,
        outputChannel: vscode.OutputChannel
    ) {
        this.secretStorage = secretStorage;
        this.globalState = globalState;
        this.outputChannel = outputChannel;
    }

    /**
     * Store a secret's fields in VS Code SecretStorage.
     * For simple secrets (bearer_token, header): stores a single value.
     * For compound secrets (basic_auth, database): stores multiple fields as JSON.
     */
    async storeSecret(declaration: SecretDeclaration, fields: SecretFields): Promise<void> {
        const storageKey = SECRET_PREFIX + declaration.name;
        await this.secretStorage.store(storageKey, JSON.stringify(fields));

        // Update metadata
        const metadata = this.getMetadataList();
        const existing = metadata.findIndex(m => m.name === declaration.name);
        const entry: StoredSecretMetadata = {
            name: declaration.name,
            type: declaration.type,
            target: declaration.target,
            storedAt: new Date().toISOString(),
        };

        if (existing >= 0) {
            metadata[existing] = entry;
        } else {
            metadata.push(entry);
        }

        await this.globalState.update(METADATA_KEY, metadata);
        this.outputChannel.appendLine(`Secret stored: ${declaration.name}`);
    }

    /**
     * Retrieve a secret's fields from VS Code SecretStorage.
     */
    async getSecret(name: string): Promise<SecretFields | undefined> {
        const storageKey = SECRET_PREFIX + name;
        const raw = await this.secretStorage.get(storageKey);
        if (!raw) {
            return undefined;
        }
        try {
            return JSON.parse(raw) as SecretFields;
        } catch {
            this.outputChannel.appendLine(`Warning: corrupt secret data for '${name}', treating as missing`);
            return undefined;
        }
    }

    /**
     * Delete a secret from VS Code SecretStorage.
     */
    async deleteSecret(name: string): Promise<void> {
        const storageKey = SECRET_PREFIX + name;
        await this.secretStorage.delete(storageKey);

        // Update metadata
        const metadata = this.getMetadataList();
        const filtered = metadata.filter(m => m.name !== name);
        await this.globalState.update(METADATA_KEY, filtered);
        this.outputChannel.appendLine(`Secret deleted: ${name}`);
    }

    /**
     * List all stored secret metadata (no values exposed).
     */
    listSecrets(): StoredSecretMetadata[] {
        return this.getMetadataList();
    }

    /**
     * Check which secrets declared in config are missing from the store.
     */
    async findMissingSecrets(declarations: SecretDeclaration[]): Promise<SecretDeclaration[]> {
        const missing: SecretDeclaration[] = [];
        for (const decl of declarations) {
            const fields = await this.getSecret(decl.name);
            if (!fields) {
                missing.push(decl);
            }
        }
        return missing;
    }

    /**
     * Generate the flat file map that Secretless Broker expects.
     * Maps file paths (under secretsDir) to their values.
     * File paths match what secretless-generator.ts produces in the config.
     */
    async generateSecretFiles(
        declarations: SecretDeclaration[]
    ): Promise<Record<string, string>> {
        const files: Record<string, string> = {};

        for (const decl of declarations) {
            const fields = await this.getSecret(decl.name);
            if (!fields) {
                continue;
            }

            switch (decl.type) {
                case 'bearer_token':
                    if (fields.value) {
                        files[decl.name] = fields.value;
                    }
                    break;
                case 'header':
                    if (fields.value) {
                        files[decl.name] = fields.value;
                    }
                    break;
                case 'basic_auth':
                    if (fields.username) {
                        files[`${decl.name}_username`] = fields.username;
                    }
                    if (fields.password) {
                        files[`${decl.name}_password`] = fields.password;
                    }
                    break;
                case 'postgresql':
                case 'mysql':
                    if (fields.host) {
                        files[`${decl.name}_host`] = fields.host;
                    }
                    if (fields.port) {
                        files[`${decl.name}_port`] = fields.port;
                    }
                    if (fields.username) {
                        files[`${decl.name}_username`] = fields.username;
                    }
                    if (fields.password) {
                        files[`${decl.name}_password`] = fields.password;
                    }
                    break;
                case 'ssh':
                    // SSH not handled by Secretless Broker
                    break;
            }
        }

        return files;
    }

    private getMetadataList(): StoredSecretMetadata[] {
        return this.globalState.get<StoredSecretMetadata[]>(METADATA_KEY, []);
    }

    dispose(): void {
        // No resources to clean up
    }
}
