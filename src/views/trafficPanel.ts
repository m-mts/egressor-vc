/**
 * Traffic Panel webview provider - displays live traffic events from httpjail
 * and secret injection events from Secretless Broker in a VS Code sidebar panel.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { TrafficEvent } from '../jail/types';
import { SecretInjectionEvent } from '../secrets/types';
import { detectHttpjail, DetectionResult, SystemOperations } from '../jail/installer';
import { detectBrokerBinary } from '../secrets/broker-manager';
import { HttpjailManager } from '../jail/manager';
import { SecretlessBrokerManager } from '../secrets/broker-manager';

/** Serialized traffic event for webview messaging */
export interface TrafficPanelMessage {
    command: 'trafficEvent' | 'secretEvent' | 'clear';
    data?: SerializedTrafficEvent | SerializedSecretEvent;
}

export interface SerializedTrafficEvent {
    type: 'traffic';
    timestamp: string;
    method?: string;
    host: string;
    path?: string;
    port?: number;
    status: string;
    category: string;
    protocol?: string;
    durationMs?: number;
}

export interface SerializedSecretEvent {
    type: 'secret';
    timestamp: string;
    secretName: string;
    secretType: string;
    target: string;
    success: boolean;
}

/** Interface for file system operations (testable) */
export interface FsReadOps {
    readFileSync(filePath: string, encoding: BufferEncoding): string;
}

/** Default file system implementation */
const defaultFsOps: FsReadOps = {
    readFileSync: (filePath: string, encoding: BufferEncoding) => fs.readFileSync(filePath, encoding),
};

/** Dependencies for health check (injectable for testing) */
export interface HealthCheckDeps {
    httpjailManager?: HttpjailManager;
    brokerManager?: SecretlessBrokerManager;
    hasSecretsConfig?: () => boolean;
    detectHttpjailFn?: (sysOps?: SystemOperations) => DetectionResult;
    detectBrokerBinaryFn?: (sysOps?: Pick<SystemOperations, 'execFileSync' | 'platform'>) => DetectionResult;
    showWarningMessage?: typeof vscode.window.showWarningMessage;
    showInformationMessage?: typeof vscode.window.showInformationMessage;
    executeCommand?: typeof vscode.commands.executeCommand;
}

export class TrafficPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'egressor.trafficPanel';

    private view?: vscode.WebviewView;
    private readonly extensionUri: vscode.Uri;
    private readonly fsOps: FsReadOps;
    private healthCheckDeps: HealthCheckDeps;

    constructor(extensionUri: vscode.Uri, fsOps?: FsReadOps, healthCheckDeps?: HealthCheckDeps) {
        this.extensionUri = extensionUri;
        this.fsOps = fsOps || defaultFsOps;
        this.healthCheckDeps = healthCheckDeps || {};
    }

    /** Set or update the health check dependencies (e.g. after managers are created) */
    setHealthCheckDeps(deps: HealthCheckDeps): void {
        this.healthCheckDeps = deps;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext, // eslint-disable-line @typescript-eslint/no-unused-vars
        _token: vscode.CancellationToken // eslint-disable-line @typescript-eslint/no-unused-vars
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'src', 'views'),
                vscode.Uri.joinPath(this.extensionUri, 'out', 'views'),
            ],
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        // Run dependency health check asynchronously (don't block panel rendering)
        this.runDependencyHealthCheck().catch(() => {
            // Best-effort; failures are logged via notifications
        });
    }

    /** Run dependency health checks and show notifications for missing/stopped dependencies */
    async runDependencyHealthCheck(): Promise<void> {
        const deps = this.healthCheckDeps;
        const detect = deps.detectHttpjailFn ?? detectHttpjail;
        const detectBroker = deps.detectBrokerBinaryFn ?? detectBrokerBinary;
        const showWarning = deps.showWarningMessage ?? vscode.window.showWarningMessage.bind(vscode.window);
        const showInfo = deps.showInformationMessage ?? vscode.window.showInformationMessage.bind(vscode.window);
        const execCmd = deps.executeCommand ?? vscode.commands.executeCommand.bind(vscode.commands);

        // Check httpjail
        const httpjailResult = detect();
        if (!httpjailResult.found) {
            const action = await showWarning(
                'httpjail is not installed. Traffic monitoring requires httpjail.',
                'View Setup Guide'
            );
            if (action === 'View Setup Guide') {
                const docUri = vscode.Uri.joinPath(this.extensionUri, 'docs', 'httpjail-rules.md');
                await execCmd('markdown.showPreview', docUri);
            }
        } else if (deps.httpjailManager && deps.httpjailManager.getState() !== 'running') {
            await showInfo(
                'httpjail is installed but not running. Run "Egressor: Start" to begin traffic monitoring.',
            );
        }

        // Check secretless-broker
        const brokerResult = detectBroker();
        const hasSecrets = deps.hasSecretsConfig ? deps.hasSecretsConfig() : false;
        if (!brokerResult.found) {
            const action = await showWarning(
                'Secretless Broker is not installed. Secret injection requires Secretless Broker.',
                'View Setup Guide'
            );
            if (action === 'View Setup Guide') {
                const docUri = vscode.Uri.joinPath(this.extensionUri, 'docs', 'secretless-broker.md');
                await execCmd('markdown.showPreview', docUri);
            }
        } else if (hasSecrets && deps.brokerManager && deps.brokerManager.getState() !== 'running') {
            await showInfo(
                'Secretless Broker is installed but not running. Run "Egressor: Start" to enable secret injection.',
            );
        }
    }

    /** Send a traffic event to the webview */
    public postTrafficEvent(event: TrafficEvent): void {
        if (!this.view) { return; }
        const serialized: SerializedTrafficEvent = {
            type: 'traffic',
            timestamp: event.timestamp.toISOString(),
            method: event.method,
            host: event.host,
            path: event.path,
            port: event.port,
            status: event.status,
            category: event.category,
            protocol: event.protocol,
            durationMs: event.durationMs,
        };
        this.view.webview.postMessage({ command: 'trafficEvent', data: serialized });
    }

    /** Send a secret injection event to the webview */
    public postSecretEvent(event: SecretInjectionEvent): void {
        if (!this.view) { return; }
        const serialized: SerializedSecretEvent = {
            type: 'secret',
            timestamp: event.timestamp.toISOString(),
            secretName: event.secretName,
            secretType: event.secretType,
            target: event.target,
            success: event.success,
        };
        this.view.webview.postMessage({ command: 'secretEvent', data: serialized });
    }

    /** Clear all events in the webview */
    public clearEvents(): void {
        if (!this.view) { return; }
        this.view.webview.postMessage({ command: 'clear' });
    }

    /** Check if the webview is currently visible */
    public get isVisible(): boolean {
        return this.view?.visible ?? false;
    }

    /** Generate a nonce for CSP */
    private getNonce(): string {
        return crypto.randomBytes(16).toString('hex');
    }

    /** Build the webview HTML content */
    private getHtmlForWebview(webview: vscode.Webview): string {
        const viewsDir = path.join(this.extensionUri.fsPath, 'src', 'views');

        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'src', 'views', 'trafficPanel.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'src', 'views', 'trafficPanel.js')
        );

        const nonce = this.getNonce();
        const cspSource = webview.cspSource;

        const templatePath = path.join(viewsDir, 'trafficPanel.html');
        let html = this.fsOps.readFileSync(templatePath, 'utf8');

        html = html.replace(/\{\{cspSource\}\}/g, cspSource);
        html = html.replace(/\{\{nonce\}\}/g, nonce);
        html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
        html = html.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());

        return html;
    }
}

/** Serialize a TrafficEvent for message passing */
export function serializeTrafficEvent(event: TrafficEvent): SerializedTrafficEvent {
    return {
        type: 'traffic',
        timestamp: event.timestamp.toISOString(),
        method: event.method,
        host: event.host,
        path: event.path,
        port: event.port,
        status: event.status,
        category: event.category,
        protocol: event.protocol,
        durationMs: event.durationMs,
    };
}

/** Serialize a SecretInjectionEvent for message passing */
export function serializeSecretEvent(event: SecretInjectionEvent): SerializedSecretEvent {
    return {
        type: 'secret',
        timestamp: event.timestamp.toISOString(),
        secretName: event.secretName,
        secretType: event.secretType,
        target: event.target,
        success: event.success,
    };
}
