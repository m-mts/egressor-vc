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
        if (this.state === 'running') {
            this.outputChannel.appendLine('Egressor is already running');
            return true;
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
                onConfigChanged: (config) => this.onConfigChanged(config),
                onConfigError: (errors) => {
                    for (const err of errors) {
                        this.outputChannel.appendLine(`Egressor config error: ${err}`);
                    }
                },
            };

            const secretsDir = path.join(this.context.globalStorageUri.fsPath, 'secrets');

            if (!this.configWatcher) {
                this.configWatcher = new ConfigWatcher(workspacePath, outputDir, callbacks, undefined, secretsDir);
            }
            this.configWatcher.start();

            const config = await this.configWatcher.reload();
            if (!config) {
                this.outputChannel.appendLine('Egressor: failed to load .egressor.yml');
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

            if (!httpjailStarted) {
                this.outputChannel.appendLine('Egressor: failed to start httpjail');
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

        // If secrets changed, update broker too
        if (config.secrets.length > 0 && this.brokerManager.getState() === 'running') {
            const configFilePath = path.join(outputDir, 'secretless.yml');
            const secretsDir = path.join(this.context.globalStorageUri.fsPath, 'secrets');
            await this.brokerManager.restart({ configFilePath, secretsDir });
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

    dispose(): void {
        // Stop everything synchronously (best-effort)
        this.httpjailManager.dispose();
        this.brokerManager.dispose();
        this.configWatcher?.dispose();
        this.credentialProvider.dispose();
        this.statusBar.dispose();
        this.diagnostics.dispose();

        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
        this.state = 'idle';
    }
}
