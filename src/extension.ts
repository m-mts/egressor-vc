import * as vscode from 'vscode';
import { EgressorSetup } from './container/setup';
import { shouldAutoStart } from './container/detector';
import { TrafficPanelProvider } from './views/trafficPanel';
import { generateSessionSummary, formatSessionSummary } from './audit/summary';

let egressorSetup: EgressorSetup | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('Egressor');
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('Egressor extension activated');

    // Create the orchestrator
    egressorSetup = new EgressorSetup({ context, outputChannel });

    // Register the traffic panel webview provider
    const trafficPanelRegistration = vscode.window.registerWebviewViewProvider(
        TrafficPanelProvider.viewType,
        egressorSetup.getTrafficPanel(),
    );
    context.subscriptions.push(trafficPanelRegistration);

    // Register commands
    const startCmd = vscode.commands.registerCommand('egressor.start', async () => {
        outputChannel.appendLine('Egressor: start command invoked');
        if (egressorSetup) {
            await egressorSetup.start();
        }
    });

    const stopCmd = vscode.commands.registerCommand('egressor.stop', async () => {
        outputChannel.appendLine('Egressor: stop command invoked');
        if (egressorSetup) {
            await egressorSetup.stop();
        }
    });

    const showSummaryCmd = vscode.commands.registerCommand('egressor.showSessionSummary', () => {
        const logger = egressorSetup?.getSessionLogger();
        if (!logger) {
            vscode.window.showWarningMessage('Egressor: No active session');
            return;
        }
        const entries = logger.getEntries();
        const summary = generateSessionSummary(
            entries,
            logger.getSessionStart(),
            new Date(),
        );
        const formatted = formatSessionSummary(summary);
        outputChannel.clear();
        outputChannel.appendLine(formatted);
        outputChannel.show();
    });

    const exportLogCmd = vscode.commands.registerCommand('egressor.exportSessionLog', async () => {
        const logger = egressorSetup?.getSessionLogger();
        if (!logger) {
            vscode.window.showWarningMessage('Egressor: No active session');
            return;
        }
        const exportData = await logger.exportLog();
        const doc = await vscode.workspace.openTextDocument({ content: exportData, language: 'json' });
        await vscode.window.showTextDocument(doc);
    });

    context.subscriptions.push(startCmd, stopCmd, showSummaryCmd, exportLogCmd);
    context.subscriptions.push(egressorSetup);

    // Auto-start if in container with .egressor.yml and autoStart enabled
    if (shouldAutoStart()) {
        outputChannel.appendLine('Egressor: auto-starting (devcontainer detected with .egressor.yml)');
        egressorSetup.start().catch(err => {
            outputChannel.appendLine(`Egressor: auto-start failed: ${err}`);
        });
    }
}

export function getEgressorSetup(): EgressorSetup | undefined {
    return egressorSetup;
}

export function deactivate(): void {
    if (egressorSetup) {
        egressorSetup.dispose();
        egressorSetup = undefined;
    }
}
