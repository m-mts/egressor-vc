import * as vscode from 'vscode';
import * as path from 'path';
import { SessionLogger } from './audit/logger';
import { generateSessionSummary, formatSessionSummary } from './audit/summary';

let sessionLogger: SessionLogger | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('Egressor');
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('Egressor extension activated');

    // Initialize session logger
    const logDir = path.join(context.globalStorageUri.fsPath, 'audit-logs');
    sessionLogger = new SessionLogger({ logDir });
    sessionLogger.start().then(
        () => outputChannel.appendLine('Egressor: audit logger started'),
        (err) => outputChannel.appendLine(`Egressor: audit logger failed to start: ${err}`),
    );

    const startCmd = vscode.commands.registerCommand('egressor.start', () => {
        outputChannel.appendLine('Egressor: start command invoked');
        vscode.window.showInformationMessage('Egressor started');
    });

    const stopCmd = vscode.commands.registerCommand('egressor.stop', () => {
        outputChannel.appendLine('Egressor: stop command invoked');
        vscode.window.showInformationMessage('Egressor stopped');
    });

    const showSummaryCmd = vscode.commands.registerCommand('egressor.showSessionSummary', () => {
        if (!sessionLogger) {
            vscode.window.showWarningMessage('Egressor: No active session');
            return;
        }
        const entries = sessionLogger.getEntries();
        const summary = generateSessionSummary(
            entries,
            sessionLogger.getSessionStart(),
            new Date(),
        );
        const formatted = formatSessionSummary(summary);
        outputChannel.clear();
        outputChannel.appendLine(formatted);
        outputChannel.show();
    });

    const exportLogCmd = vscode.commands.registerCommand('egressor.exportSessionLog', async () => {
        if (!sessionLogger) {
            vscode.window.showWarningMessage('Egressor: No active session');
            return;
        }
        const exportData = await sessionLogger.exportLog();
        const doc = await vscode.workspace.openTextDocument({ content: exportData, language: 'json' });
        await vscode.window.showTextDocument(doc);
    });

    context.subscriptions.push(startCmd, stopCmd, showSummaryCmd, exportLogCmd);
}

export function getSessionLogger(): SessionLogger | undefined {
    return sessionLogger;
}

export function deactivate(): void {
    sessionLogger = undefined;
}
