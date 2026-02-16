import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseConfig, resolveConfig } from './parser';
import { generateSecretlessYaml } from './secretless-generator';
import { generateHttpjailRules } from './httpjail-rules-generator';
import { ResolvedConfig } from './types';

export interface ConfigWatcherCallbacks {
    onConfigChanged: (config: ResolvedConfig) => void;
    onConfigError: (errors: string[]) => void;
}

/** Filesystem abstraction for testability */
export interface FileSystem {
    readFileSync(path: string, encoding: string): string;
    writeFileSync(path: string, content: string): void;
    existsSync(path: string): boolean;
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

/** Default filesystem implementation using Node's fs module */
const defaultFs: FileSystem = {
    readFileSync: (p, enc) => fs.readFileSync(p, enc as BufferEncoding) as string,
    writeFileSync: (p, content) => fs.writeFileSync(p, content),
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
};

/**
 * Watches .egressor.yml for changes and regenerates derived config files.
 */
export class ConfigWatcher implements vscode.Disposable {
    private watcher: vscode.FileSystemWatcher | undefined;
    private disposables: vscode.Disposable[] = [];
    private currentConfig: ResolvedConfig | undefined;
    private outputDir: string;
    private secretsDir: string;
    private callbacks: ConfigWatcherCallbacks;
    private fs: FileSystem;

    constructor(
        private workspaceRoot: string,
        outputDir: string,
        callbacks: ConfigWatcherCallbacks,
        fileSystem?: FileSystem,
        secretsDir?: string
    ) {
        this.outputDir = outputDir;
        this.secretsDir = secretsDir ?? '/run/secrets';
        this.callbacks = callbacks;
        this.fs = fileSystem ?? defaultFs;
    }

    /** Start watching for config file changes */
    start(): void {
        // Dispose previous watcher to prevent leaks on re-start
        if (this.watcher) {
            for (const d of this.disposables) {
                d.dispose();
            }
            this.disposables = [];
            this.watcher = undefined;
        }

        const pattern = new vscode.RelativePattern(this.workspaceRoot, '.egressor.yml');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.disposables.push(
            this.watcher.onDidChange(() => this.reload()),
            this.watcher.onDidCreate(() => this.reload()),
            this.watcher.onDidDelete(() => this.handleDelete()),
            this.watcher
        );
    }

    /** Load and process the config file */
    async reload(): Promise<ResolvedConfig | undefined> {
        const configPath = path.join(this.workspaceRoot, '.egressor.yml');

        let content: string;
        try {
            content = this.fs.readFileSync(configPath, 'utf-8');
        } catch {
            this.callbacks.onConfigError(['Could not read .egressor.yml']);
            return undefined;
        }

        const result = parseConfig(content);
        if (!result.ok) {
            this.callbacks.onConfigError(result.errors.map(e => `${e.field}: ${e.message}`));
            return undefined;
        }

        const resolved = resolveConfig(result.config);
        this.currentConfig = resolved;

        // Generate derived config files
        this.writeDerivedConfigs(resolved);

        this.callbacks.onConfigChanged(resolved);
        return resolved;
    }

    /** Write generated httpjail rules and secretless.yml */
    private writeDerivedConfigs(config: ResolvedConfig): void {
        if (!this.fs.existsSync(this.outputDir)) {
            this.fs.mkdirSync(this.outputDir, { recursive: true });
        }

        // Write httpjail rules
        const rulesContent = generateHttpjailRules(config);
        this.fs.writeFileSync(path.join(this.outputDir, 'httpjail-rules.js'), rulesContent);

        // Write secretless.yml if secrets are configured
        if (config.secrets.length > 0) {
            const secretlessContent = generateSecretlessYaml(config, this.secretsDir);
            this.fs.writeFileSync(path.join(this.outputDir, 'secretless.yml'), secretlessContent);
        }
    }

    private handleDelete(): void {
        this.currentConfig = undefined;
        this.callbacks.onConfigError(['.egressor.yml was deleted']);
    }

    /** Get the current resolved config */
    getConfig(): ResolvedConfig | undefined {
        return this.currentConfig;
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
        this.watcher = undefined;
    }
}
