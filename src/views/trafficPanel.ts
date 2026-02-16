/**
 * Traffic Panel webview provider - displays live traffic events from httpjail
 * and secret injection events from Secretless Broker in a VS Code sidebar panel.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TrafficEvent } from '../jail/types';
import { SecretInjectionEvent } from '../secrets/types';

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

export class TrafficPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'egressor.trafficPanel';

    private view?: vscode.WebviewView;
    private readonly extensionUri: vscode.Uri;
    private readonly fsOps: FsReadOps;

    constructor(extensionUri: vscode.Uri, fsOps?: FsReadOps) {
        this.extensionUri = extensionUri;
        this.fsOps = fsOps || defaultFsOps;
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
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i++) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
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
