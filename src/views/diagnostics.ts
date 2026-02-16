import * as vscode from 'vscode';
import { TrafficEvent } from '../jail/types';

export class DiagnosticsManager implements vscode.Disposable {
    private collection: vscode.DiagnosticCollection;
    private blockedEvents: TrafficEvent[] = [];
    private maxDiagnostics: number;

    constructor(maxDiagnostics = 100) {
        this.collection = vscode.languages.createDiagnosticCollection('egressor');
        this.maxDiagnostics = maxDiagnostics;
    }

    onTrafficEvent(event: TrafficEvent): void {
        if (event.status !== 'blocked') {
            return;
        }
        this.blockedEvents.push(event);
        if (this.blockedEvents.length > this.maxDiagnostics) {
            this.blockedEvents.shift();
        }
        this.refreshDiagnostics();
    }

    clear(): void {
        this.blockedEvents = [];
        this.collection.clear();
    }

    get events(): ReadonlyArray<TrafficEvent> {
        return this.blockedEvents;
    }

    private refreshDiagnostics(): void {
        const diagnostics: vscode.Diagnostic[] = this.blockedEvents.map(event => {
            const message = this.formatMessage(event);
            const range = new vscode.Range(0, 0, 0, 0);
            const diagnostic = new vscode.Diagnostic(
                range,
                message,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'Egressor';
            return diagnostic;
        });

        const uri = vscode.Uri.parse('egressor:blocked-traffic');
        this.collection.set(uri, diagnostics);
    }

    private formatMessage(event: TrafficEvent): string {
        if (event.category === 'http') {
            const method = event.method || 'UNKNOWN';
            const path = event.path || '/';
            return `Blocked ${method} ${event.host}${path}`;
        }
        const protocol = event.protocol || 'tcp';
        const port = event.port ? `:${event.port}` : '';
        return `Blocked non-HTTP traffic: ${protocol} to ${event.host}${port}`;
    }

    dispose(): void {
        this.collection.dispose();
    }
}
