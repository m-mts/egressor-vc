/**
 * Orchestrates the full Egressor lifecycle: config parsing, httpjail startup,
 * Secretless Broker startup, event wiring, and graceful shutdown.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigWatcher, ConfigWatcherCallbacks } from '../config/watcher';
import { ResolvedConfig } from '../config/types';
import { HttpjailManager } from '../jail/manager';
import { SecretlessBrokerManager } from '../secrets/broker-manager';
import { CredentialProvider } from '../secrets/credential-provider';
import { promptForMissingSecrets } from '../secrets/prompt';
import { TrafficPanelProvider } from '../views/trafficPanel';
import { StatusBarManager } from '../views/statusBar';
import { DiagnosticsManager } from '../views/diagnostics';
import { SessionLogger } from '../audit/logger';
import { ContainerContext, detectContainer, VscodeEnv } from './detector';
import { TrafficEvent } from '../jail/types';
import { SecretInjectionEvent } from '../secrets/types';

/** Options for creating the EgressorSetup orchestrator */
export interface SetupOptions {
    /** VS Code extension context */
    context: vscode.ExtensionContext;
    /** Output channel for logging */
    outputChannel: vscode.OutputChannel;
    /** Optional: override container detection for testing */
    vscodeEnv?: VscodeEnv;
    /** Optional: override httpjail manager for testing */
    httpjailManager?: HttpjailManager;
    /** Optional: override broker manager for testing */
    brokerManager?: SecretlessBrokerManager;
    /** Optional: override config watcher for testing */
    configWatcher?: ConfigWatcher;
    /** Optional: override credential provider for testing */
    credentialProvider?: CredentialProvider;
    /** Optional: override session logger for testing */
    sessionLogger?: SessionLogger;
    /** Optional: override status bar for testing */
    statusBar?: StatusBarManager;
    /** Optional: override diagnostics for testing */
    diagnostics?: DiagnosticsManager;
    /** Optional: override traffic panel for testing */
    trafficPanel?: TrafficPanelProvider;
}

/** Current state of the Egressor orchestrator */
export type SetupState = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

/**
 * Orchestrates all Egressor components for a container session.
 */
export class EgressorSetup implements vscode.Disposable {
    private state: SetupState = 'idle';
    private readonly context: vscode.ExtensionContext;
    private readonly outputChannel: vscode.OutputChannel;
    private readonly disposables: vscode.Disposable[] = [];

    // Components
    private httpjailManager: HttpjailManager;
    private brokerManager: SecretlessBrokerManager;
    private configWatcher: ConfigWatcher | undefined;
    private credentialProvider: CredentialProvider;
    private sessionLogger: SessionLogger;
    private statusBar: StatusBarManager;
    private diagnostics: DiagnosticsManager;
    private trafficPanel: TrafficPanelProvider;

    private containerContext: ContainerContext | undefined;
    private currentConfig: ResolvedConfig | undefined;
    private suppressConfigCallback = false;
    private disposed = false;

    constructor(options: SetupOptions) {
        this.context = options.context;
        this.outputChannel = options.outputChannel;

        const logDir = path.join(options.context.globalStorageUri.fsPath, 'audit-logs');

        this.httpjailManager = options.httpjailManager ?? new HttpjailManager(options.outputChannel);
        this.brokerManager = options.brokerManager ?? new SecretlessBrokerManager(options.outputChannel);
        this.credentialProvider = options.credentialProvider ?? new CredentialProvider(
            options.context.secrets,
            options.context.globalState,
            options.outputChannel,
        );
        this.sessionLogger = options.sessionLogger ?? new SessionLogger({ logDir });
        this.statusBar = options.statusBar ?? new StatusBarManager();
        this.diagnostics = options.diagnostics ?? new DiagnosticsManager();
        this.trafficPanel = options.trafficPanel ?? new TrafficPanelProvider(options.context.extensionUri);

        if (options.configWatcher) {
            this.configWatcher = options.configWatcher;
        }
    }

    /** Get the current orchestrator state */
    getState(): SetupState {
        return this.state;
    }

    /** Get the traffic panel provider (for webview registration) */
    getTrafficPanel(): TrafficPanelProvider {
        return this.trafficPanel;
    }

    /** Get the status bar manager */
    getStatusBar(): StatusBarManager {
        return this.statusBar;
    }

    /** Get the session logger */
    getSessionLogger(): SessionLogger {
        return this.sessionLogger;
    }

    /** Get the credential provider */
    getCredentialProvider(): CredentialProvider {
        return this.credentialProvider;
    }

    /**
     * Start the full Egressor pipeline:
     * 1. Detect container context
     * 2. Parse .egressor.yml and generate derived configs
     * 3. Prompt for missing secrets
     * 4. Start httpjail with generated rules
     * 5. Start Secretless Broker with generated config
     * 6. Wire all event listeners
     * 7. Start session logger
     */
    async start(): Promise<boolean> {
        if (this.state === 'running' || this.state === 'starting' || this.state === 'stopping') {
            this.outputChannel.appendLine('Egressor is already running, starting, or stopping');
            return this.state === 'running';
        }

        this.state = 'starting';
        this.outputChannel.appendLine('Egressor: starting...');

        try {
            // 1. Detect container context
            this.containerContext = detectContainer();
            this.outputChannel.appendLine(
                `Egressor: container context - isContainer: ${this.containerContext.isContainer}, ` +
                `remoteName: ${this.containerContext.remoteName ?? 'none'}`
            );

            // 2. Set up config watcher and do initial config load
            const workspacePath = this.containerContext.workspacePath
                ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

            if (!workspacePath) {
                this.outputChannel.appendLine('Egressor: no workspace folder found');
                this.state = 'error';
                return false;
            }

            const outputDir = path.join(this.context.globalStorageUri.fsPath, 'generated');

            const callbacks: ConfigWatcherCallbacks = {
                onConfigChanged: (config) => {
                    if (this.suppressConfigCallback) { return; }
                    this.onConfigChanged(config).catch(err => {
                        this.outputChannel.appendLine(`Egressor: config reload failed: ${err}`);
                    });
                },
                onConfigError: (errors) => {
                    for (const err of errors) {
                        this.outputChannel.appendLine(`Egressor config error: ${err}`);
                    }
                },
                onConfigDeleted: () => {
                    this.outputChannel.appendLine('Egressor: .egressor.yml deleted, stopping enforcement');
                    this.stop().catch(err => {
                        this.outputChannel.appendLine(`Egressor: stop after config delete failed: ${err}`);
                    });
                },
            };

            const secretsDir = path.join(this.context.globalStorageUri.fsPath, 'secrets');

            if (!this.configWatcher) {
                this.configWatcher = new ConfigWatcher(workspacePath, outputDir, callbacks, undefined, secretsDir);
            }
            this.configWatcher.start();

            // Suppress onConfigChanged during initial reload to avoid
            // double-processing secrets (start() handles them directly)
            this.suppressConfigCallback = true;
            let config: ResolvedConfig | undefined;
            try {
                config = await this.configWatcher.reload();
            } finally {
                this.suppressConfigCallback = false;
            }
            if (!config) {
                this.outputChannel.appendLine('Egressor: failed to load .egressor.yml');
                await this.cleanupPartialStart();
                this.state = 'error';
                return false;
            }
            this.currentConfig = config;

            // 3. Check for and prompt missing secrets
            if (config.secrets.length > 0) {
                await promptForMissingSecrets(config.secrets, this.credentialProvider);

                // Write secret files for Secretless Broker
                const secretFiles = await this.credentialProvider.generateSecretFiles(config.secrets);
                this.brokerManager.writeSecretFiles(secretsDir, secretFiles);
            }

            // 4. Wire event listeners before starting processes
            this.wireEventListeners();

            // 5. Start session logger
            await this.sessionLogger.start();

            // 6. Start httpjail
            const rulesFilePath = path.join(outputDir, 'httpjail-rules.js');
            const httpjailStarted = await this.httpjailManager.start({
                rulesFilePath,
                containerId: this.containerContext.containerId,
                strongMode: this.containerContext.isContainer,
            });

            // Check if stop() was called while we were starting (before treating
            // a manager failure as an error - the failure may be due to intentional shutdown)
            if (this.state !== 'starting') {
                this.outputChannel.appendLine('Egressor: start cancelled (stop was called during startup)');
                await this.cleanupPartialStart();
                await this.httpjailManager.stop().catch(() => {});
                await this.brokerManager.stop().catch(() => {});
                this.state = 'idle';
                return false;
            }

            if (!httpjailStarted) {
                this.outputChannel.appendLine('Egressor: failed to start httpjail');
                await this.cleanupPartialStart();
                this.state = 'error';
                return false;
            }

            // 7. Start Secretless Broker if secrets configured
            if (config.secrets.length > 0) {
                const configFilePath = path.join(outputDir, 'secretless.yml');
                const brokerStarted = await this.brokerManager.start({
                    configFilePath,
                    secretsDir,
                });

                if (!brokerStarted) {
                    this.outputChannel.appendLine('Egressor: failed to start Secretless Broker (continuing without it)');
                }
            }

            this.state = 'running';
            this.outputChannel.appendLine('Egressor: started successfully');
            vscode.window.showInformationMessage('Egressor started - traffic monitoring active');
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.outputChannel.appendLine(`Egressor: startup failed: ${message}`);
            await this.cleanupPartialStart();
            this.state = 'error';
            return false;
        }
    }

    /**
     * Graceful shutdown: stop httpjail, stop broker, flush audit log.
     */
    async stop(): Promise<void> {
        if (this.state === 'idle' || this.state === 'stopping') {
            return;
        }

        this.state = 'stopping';
        this.outputChannel.appendLine('Egressor: stopping...');

        // Stop processes in parallel
        const stopPromises: Promise<void>[] = [];

        stopPromises.push(
            this.httpjailManager.stop().catch(err => {
                this.outputChannel.appendLine(`Egressor: error stopping httpjail: ${err}`);
            })
        );

        stopPromises.push(
            this.brokerManager.stop().catch(err => {
                this.outputChannel.appendLine(`Egressor: error stopping broker: ${err}`);
            })
        );

        await Promise.all(stopPromises);

        // Stop config watcher
        this.configWatcher?.dispose();
        this.configWatcher = undefined;

        // Flush audit log
        await this.sessionLogger.stop();

        // Dispose event listener subscriptions
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;

        this.state = 'idle';
        this.outputChannel.appendLine('Egressor: stopped');
        vscode.window.showInformationMessage('Egressor stopped');
    }

    /**
     * Handle config changes: reload httpjail rules, regenerate secretless config.
     */
    private async onConfigChanged(config: ResolvedConfig): Promise<void> {
        this.currentConfig = config;
        this.outputChannel.appendLine('Egressor: config changed, reloading...');

        const outputDir = path.join(this.context.globalStorageUri.fsPath, 'generated');
        const rulesFilePath = path.join(outputDir, 'httpjail-rules.js');

        if (this.httpjailManager.getState() === 'running') {
            await this.httpjailManager.reloadRules(rulesFilePath);
        }

        // If secrets changed, prompt for new ones and update broker
        if (config.secrets.length > 0) {
            const secretsDir = path.join(this.context.globalStorageUri.fsPath, 'secrets');

            // Prompt for any newly added secrets
            await promptForMissingSecrets(config.secrets, this.credentialProvider);

            // Regenerate secret files
            const secretFiles = await this.credentialProvider.generateSecretFiles(config.secrets);
            this.brokerManager.writeSecretFiles(secretsDir, secretFiles);

            const configFilePath = path.join(outputDir, 'secretless.yml');
            if (this.brokerManager.getState() === 'running') {
                await this.brokerManager.restart({ configFilePath, secretsDir });
            } else {
                await this.brokerManager.start({ configFilePath, secretsDir });
            }
        } else {
            // Secrets removed from config - stop broker if running
            if (this.brokerManager.getState() === 'running') {
                await this.brokerManager.stop();
            }
        }
    }

    /**
     * Wire traffic and secret injection events to all consumers:
     * - Traffic Panel (webview)
     * - Status Bar
     * - Diagnostics
     * - Session Logger
     */
    private wireEventListeners(): void {
        // httpjail traffic events
        const trafficSub = this.httpjailManager.onTrafficEvent((event: TrafficEvent) => {
            this.trafficPanel.postTrafficEvent(event);
            this.statusBar.onTrafficEvent(event);
            this.diagnostics.onTrafficEvent(event);
            this.sessionLogger.logTrafficEvent(event).catch(err => {
                this.outputChannel.appendLine(`Egressor: audit log error: ${err}`);
            });
        });
        this.disposables.push(trafficSub);

        // Secretless Broker events
        const secretSub = this.brokerManager.onSecretInjection((event: SecretInjectionEvent) => {
            this.trafficPanel.postSecretEvent(event);
            this.sessionLogger.logSecretInjectionEvent(event).catch(err => {
                this.outputChannel.appendLine(`Egressor: audit log error: ${err}`);
            });
        });
        this.disposables.push(secretSub);
    }

    /** Clean up resources allocated during a partial/failed start */
    private async cleanupPartialStart(): Promise<void> {
        this.configWatcher?.dispose();
        this.configWatcher = undefined;
        await this.sessionLogger.stop().catch(() => {});
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;

        // Stop everything synchronously (best-effort)
        this.httpjailManager.dispose();
        this.brokerManager.dispose();
        this.configWatcher?.dispose();
        this.credentialProvider.dispose();
        this.statusBar.dispose();
        this.diagnostics.dispose();
        // Stop session logger to prevent further writes
        this.sessionLogger.stop().catch(() => {});

        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
        this.state = 'idle';
    }
}
