import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, SpawnOptions, spawn as nodeSpawn } from 'child_process';
import {
    BrokerProcessState,
    BrokerStartOptions,
    BrokerHealthStatus,
    SecretInjectionEvent,
    SecretInjectionListener,
} from './types';
import { parseBrokerLogLine, createBrokerStreamParser } from './broker-events';

/** Interface for spawning child processes, enabling testability */
export interface ProcessSpawner {
    spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
}

/** Default process spawner using Node.js child_process */
const defaultSpawner: ProcessSpawner = {
    spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess {
        return nodeSpawn(command, args, options ?? {});
    },
};

/** Interface for file system operations, enabling testability */
export interface FileSystemOps {
    existsSync(path: string): boolean;
    mkdirSync(path: string, options?: { recursive: boolean }): void;
    writeFileSync(path: string, content: string): void;
    unlinkSync(path: string): void;
}

const defaultFsOps: FileSystemOps = {
    existsSync: (p: string) => fs.existsSync(p),
    mkdirSync: (p: string, opts?: { recursive: boolean }) => {
        fs.mkdirSync(p, opts);
    },
    writeFileSync: (p: string, content: string) => {
        fs.writeFileSync(p, content, { mode: 0o600 });
    },
    unlinkSync: (p: string) => {
        fs.unlinkSync(p);
    },
};

/**
 * Manages the Secretless Broker process lifecycle: start, stop, restart, health check.
 * Parses broker output into structured secret injection events.
 */
export class SecretlessBrokerManager implements vscode.Disposable {
    private process: ChildProcess | undefined;
    private state: BrokerProcessState = 'stopped';
    private startTime: number | undefined;
    private lastError: string | undefined;
    private listeners: SecretInjectionListener[] = [];
    private streamParser: ReturnType<typeof createBrokerStreamParser> | undefined;
    private spawner: ProcessSpawner;
    private fsOps: FileSystemOps;
    private outputChannel: vscode.OutputChannel;
    private currentOptions: BrokerStartOptions | undefined;

    constructor(
        outputChannel: vscode.OutputChannel,
        spawner?: ProcessSpawner,
        fsOps?: FileSystemOps
    ) {
        this.outputChannel = outputChannel;
        this.spawner = spawner ?? defaultSpawner;
        this.fsOps = fsOps ?? defaultFsOps;
    }

    /** Register a listener for secret injection events */
    onSecretInjection(listener: SecretInjectionListener): vscode.Disposable {
        this.listeners.push(listener);
        return {
            dispose: () => {
                const idx = this.listeners.indexOf(listener);
                if (idx >= 0) {
                    this.listeners.splice(idx, 1);
                }
            },
        };
    }

    /** Emit a secret injection event to all listeners */
    private emitEvent(event: SecretInjectionEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    /** Get the current process state */
    getState(): BrokerProcessState {
        return this.state;
    }

    /**
     * Write secret values to files in the secrets directory.
     * Secretless Broker reads credentials from these files.
     */
    writeSecretFiles(
        secretsDir: string,
        secrets: Record<string, string>
    ): void {
        if (!this.fsOps.existsSync(secretsDir)) {
            this.fsOps.mkdirSync(secretsDir, { recursive: true });
        }

        for (const [name, value] of Object.entries(secrets)) {
            const filePath = path.join(secretsDir, name);
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(path.resolve(secretsDir) + path.sep)) {
                throw new Error(`Invalid secret name: ${name} (path traversal detected)`);
            }
            this.fsOps.writeFileSync(filePath, value);
        }
    }

    /**
     * Remove secret files from the secrets directory.
     */
    removeSecretFiles(secretsDir: string, names: string[]): void {
        for (const name of names) {
            const filePath = path.join(secretsDir, name);
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(path.resolve(secretsDir) + path.sep)) {
                throw new Error(`Invalid secret name: ${name} (path traversal detected)`);
            }
            if (this.fsOps.existsSync(filePath)) {
                this.fsOps.unlinkSync(filePath);
            }
        }
    }

    /**
     * Start the Secretless Broker with the given options.
     */
    async start(options: BrokerStartOptions): Promise<boolean> {
        if (this.state === 'running') {
            this.outputChannel.appendLine('Secretless Broker is already running');
            return true;
        }

        this.state = 'starting';
        this.currentOptions = options;

        const args = this.buildArgs(options);
        const binaryPath = 'secretless-broker';
        this.outputChannel.appendLine(`Starting Secretless Broker: ${binaryPath} ${args.join(' ')}`);

        try {
            this.process = this.spawner.spawn(binaryPath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            // Wait for a definitive spawn outcome before reporting success.
            // 'spawn' fires when the OS successfully starts the process.
            // 'error' fires on spawn failure (e.g. ENOENT).
            // 'exit' fires if the process crashes immediately after spawning.
            const spawnOk = await new Promise<boolean>((resolve) => {
                let settled = false;
                const settle = (ok: boolean) => {
                    if (settled) { return; }
                    settled = true;
                    this.process?.removeListener('spawn', onSpawn);
                    this.process?.removeListener('error', onError);
                    this.process?.removeListener('exit', onExit);
                    resolve(ok);
                };
                const onSpawn = () => {
                    settle(true);
                };
                const onError = (err: Error) => {
                    this.state = 'error';
                    this.lastError = err.message;
                    this.outputChannel.appendLine(`Failed to start Secretless Broker: ${err.message}`);
                    settle(false);
                };
                const onExit = (code: number | null, signal: string | null) => {
                    this.state = 'error';
                    this.lastError = `Secretless Broker exited immediately (code: ${code}, signal: ${signal})`;
                    this.outputChannel.appendLine(this.lastError);
                    settle(false);
                };
                this.process!.once('spawn', onSpawn);
                this.process!.once('error', onError);
                this.process!.once('exit', onExit);
            });

            if (!spawnOk) {
                return false;
            }

            this.setupStreamHandlers();

            this.state = 'running';
            this.startTime = Date.now();
            this.lastError = undefined;
            this.outputChannel.appendLine(`Secretless Broker started (PID: ${this.process.pid})`);

            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.state = 'error';
            this.lastError = message;
            this.outputChannel.appendLine(`Failed to start Secretless Broker: ${message}`);
            return false;
        }
    }

    /**
     * Stop the Secretless Broker process.
     */
    async stop(): Promise<void> {
        if (!this.process || this.state === 'stopped') {
            this.state = 'stopped';
            return;
        }

        this.state = 'stopping';
        this.outputChannel.appendLine('Stopping Secretless Broker...');

        return new Promise<void>((resolve) => {
            let cleaned = false;
            const timeout = setTimeout(() => {
                if (this.process) {
                    this.process.kill('SIGKILL');
                }
                cleanup();
            }, 5000);

            const cleanup = () => {
                if (cleaned) { return; }
                cleaned = true;
                clearTimeout(timeout);
                if (this.streamParser) {
                    this.streamParser.flush();
                    this.streamParser = undefined;
                }
                this.process = undefined;
                this.state = 'stopped';
                this.startTime = undefined;
                this.outputChannel.appendLine('Secretless Broker stopped');
                resolve();
            };

            if (this.process) {
                this.process.once('exit', cleanup);
                this.process.kill('SIGTERM');
            } else {
                cleanup();
            }
        });
    }

    /**
     * Restart the broker with the same or new options.
     */
    async restart(options?: BrokerStartOptions): Promise<boolean> {
        await this.stop();
        const opts = options || this.currentOptions;
        if (!opts) {
            this.state = 'error';
            this.lastError = 'No options available for restart';
            return false;
        }
        return this.start(opts);
    }

    /**
     * Get the health status of the broker process.
     */
    healthCheck(): BrokerHealthStatus {
        return {
            alive: this.state === 'running' && this.process !== undefined && !this.process.killed,
            state: this.state,
            pid: this.process?.pid,
            uptimeMs: this.startTime ? Date.now() - this.startTime : undefined,
            error: this.lastError,
        };
    }

    /** Build command-line arguments for secretless-broker */
    private buildArgs(options: BrokerStartOptions): string[] {
        const args: string[] = [];

        args.push('-f', options.configFilePath);

        if (options.healthCheckPort !== undefined && options.healthCheckPort !== null) {
            args.push('-p', String(options.healthCheckPort));
        }

        return args;
    }

    /** Set up stdout/stderr stream handlers to parse injection events */
    private setupStreamHandlers(): void {
        if (!this.process) {
            return;
        }

        this.streamParser = createBrokerStreamParser((event: SecretInjectionEvent) => {
            this.emitEvent(event);
        });

        if (this.process.stdout) {
            this.process.stdout.on('data', (chunk: Buffer) => {
                this.streamParser?.push(chunk.toString());
            });
        }

        if (this.process.stderr) {
            this.process.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                this.outputChannel.appendLine(`secretless-broker stderr: ${text.trim()}`);
                this.streamParser?.push(text);
            });
        }

        this.process.on('exit', (code, signal) => {
            if (this.state === 'running' || this.state === 'starting') {
                this.state = 'error';
                this.lastError = `Secretless Broker exited unexpectedly (code: ${code}, signal: ${signal})`;
                this.outputChannel.appendLine(this.lastError);
            }
            if (this.streamParser) {
                this.streamParser.flush();
            }
        });

        this.process.on('error', (err) => {
            this.state = 'error';
            this.lastError = err.message;
            this.outputChannel.appendLine(`Secretless Broker error: ${err.message}`);
        });
    }

    dispose(): void {
        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
        }
        if (this.streamParser) {
            this.streamParser.flush();
        }
        this.listeners = [];
        this.process = undefined;
        this.state = 'stopped';
    }
}

// Re-export parseBrokerLogLine for external use
export { parseBrokerLogLine };
