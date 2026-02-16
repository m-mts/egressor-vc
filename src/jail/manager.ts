import * as vscode from 'vscode';
import { ChildProcess, SpawnOptions, spawn as nodeSpawn } from 'child_process';
import {
    JailProcessState,
    JailStartOptions,
    JailHealthStatus,
    TrafficEvent,
    TrafficEventListener,
} from './types';
import { createStreamParser } from './events';
import { detectHttpjail, promptInstall, DetectionResult, SystemOperations } from './installer';

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

/**
 * Manages the httpjail process lifecycle: start, stop, restart, health check.
 * Parses httpjail output into structured traffic events and emits them to listeners.
 */
export class HttpjailManager implements vscode.Disposable {
    private process: ChildProcess | undefined;
    private state: JailProcessState = 'stopped';
    private binaryPath: string | undefined;
    private startTime: number | undefined;
    private lastError: string | undefined;
    private listeners: TrafficEventListener[] = [];
    private streamParser: ReturnType<typeof createStreamParser> | undefined;
    private spawner: ProcessSpawner;
    private sysOps: SystemOperations | undefined;
    private outputChannel: vscode.OutputChannel;
    private currentOptions: JailStartOptions | undefined;

    constructor(
        outputChannel: vscode.OutputChannel,
        spawner?: ProcessSpawner,
        sysOps?: SystemOperations
    ) {
        this.outputChannel = outputChannel;
        this.spawner = spawner ?? defaultSpawner;
        this.sysOps = sysOps;
    }

    /** Register a listener for traffic events */
    onTrafficEvent(listener: TrafficEventListener): vscode.Disposable {
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

    /** Emit a traffic event to all listeners */
    private emitEvent(event: TrafficEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    /** Get the current process state */
    getState(): JailProcessState {
        return this.state;
    }

    /**
     * Ensure httpjail binary is available.
     * Returns the binary path or undefined if not found and user declined install.
     */
    async ensureBinary(): Promise<string | undefined> {
        if (this.binaryPath) {
            return this.binaryPath;
        }

        // Check user-configured path first
        const configuredPath = vscode.workspace.getConfiguration('egressor').get<string>('httpjailPath');
        if (configuredPath) {
            this.binaryPath = configuredPath;
            this.outputChannel.appendLine(`httpjail using configured path: ${configuredPath}`);
            return this.binaryPath;
        }

        const detection: DetectionResult = detectHttpjail(this.sysOps);
        if (detection.found && detection.path) {
            this.binaryPath = detection.path;
            this.outputChannel.appendLine(`httpjail found at ${detection.path} (version: ${detection.version || 'unknown'})`);
            return this.binaryPath;
        }

        const installed = await promptInstall(this.sysOps);
        if (installed) {
            this.binaryPath = installed;
            return this.binaryPath;
        }

        return undefined;
    }

    /**
     * Start httpjail with the given options.
     */
    async start(options: JailStartOptions): Promise<boolean> {
        if (this.state === 'running') {
            this.outputChannel.appendLine('httpjail is already running');
            return true;
        }

        const binary = await this.ensureBinary();
        if (!binary) {
            this.state = 'error';
            this.lastError = 'httpjail binary not found';
            return false;
        }

        this.state = 'starting';
        this.currentOptions = options;

        const args = this.buildArgs(options);
        this.outputChannel.appendLine(`Starting httpjail: ${binary} ${args.join(' ')}`);

        try {
            this.process = this.spawner.spawn(binary, args, {
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
                    this.outputChannel.appendLine(`Failed to start httpjail: ${err.message}`);
                    settle(false);
                };
                const onExit = (code: number | null, signal: string | null) => {
                    this.state = 'error';
                    this.lastError = `httpjail exited immediately (code: ${code}, signal: ${signal})`;
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
            this.outputChannel.appendLine(`httpjail started (PID: ${this.process.pid})`);

            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.state = 'error';
            this.lastError = message;
            this.outputChannel.appendLine(`Failed to start httpjail: ${message}`);
            return false;
        }
    }

    /**
     * Stop the httpjail process.
     */
    async stop(): Promise<void> {
        if (!this.process || this.state === 'stopped') {
            this.state = 'stopped';
            return;
        }

        this.state = 'stopping';
        this.outputChannel.appendLine('Stopping httpjail...');

        return new Promise<void>((resolve) => {
            let cleaned = false;
            const timeout = setTimeout(() => {
                // Force kill if graceful shutdown times out
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
                this.outputChannel.appendLine('httpjail stopped');
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
     * Restart httpjail with the same or new options.
     */
    async restart(options?: JailStartOptions): Promise<boolean> {
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
     * Get the health status of the httpjail process.
     */
    healthCheck(): JailHealthStatus {
        return {
            alive: this.state === 'running' && this.process !== undefined && !this.process.killed,
            state: this.state,
            pid: this.process?.pid,
            uptimeMs: this.startTime ? Date.now() - this.startTime : undefined,
            error: this.lastError,
        };
    }

    /**
     * Reload rules by restarting httpjail with a new rules file path.
     */
    async reloadRules(rulesFilePath: string): Promise<boolean> {
        if (this.state !== 'running' || !this.currentOptions) {
            return false;
        }

        this.outputChannel.appendLine(`Reloading httpjail rules from ${rulesFilePath}`);
        return this.restart({ ...this.currentOptions, rulesFilePath });
    }

    /** Build command-line arguments for httpjail */
    private buildArgs(options: JailStartOptions): string[] {
        const args: string[] = [];

        // Rules file
        args.push('--rules', options.rulesFilePath);

        // Docker container mode
        if (options.containerId) {
            args.push('--docker-run', options.containerId);
        }

        // Strong mode (nftables)
        if (options.strongMode) {
            args.push('--strong');
        }

        // Proxy port
        if (options.proxyPort !== undefined && options.proxyPort !== null) {
            args.push('--port', String(options.proxyPort));
        }

        return args;
    }

    /** Set up stdout/stderr stream handlers to parse traffic events */
    private setupStreamHandlers(): void {
        if (!this.process) {
            return;
        }

        this.streamParser = createStreamParser((event: TrafficEvent) => {
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
                this.outputChannel.appendLine(`httpjail stderr: ${text.trim()}`);
                // Also try to parse stderr for traffic events (some modes log there)
                this.streamParser?.push(text);
            });
        }

        this.process.on('exit', (code, signal) => {
            if (this.state === 'running' || this.state === 'starting') {
                // Unexpected exit (including immediate exit during startup)
                this.state = 'error';
                this.lastError = `httpjail exited unexpectedly (code: ${code}, signal: ${signal})`;
                this.outputChannel.appendLine(this.lastError);
            }
            if (this.streamParser) {
                this.streamParser.flush();
            }
        });

        this.process.on('error', (err) => {
            this.state = 'error';
            this.lastError = err.message;
            this.outputChannel.appendLine(`httpjail error: ${err.message}`);
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
