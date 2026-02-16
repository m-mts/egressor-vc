import * as vscode from 'vscode';
import { EgressorSetup } from './container/setup';
import { shouldAutoStart } from './container/detector';
import { TrafficPanelProvider } from './views/trafficPanel';
import { generateSessionSummary, formatSessionSummary } from './audit/summary';
import { promptForSecret } from './secrets/prompt';

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

    const storeSecretCmd = vscode.commands.registerCommand('egressor.storeSecret', async () => {
        const provider = egressorSetup?.getCredentialProvider();
        if (!provider) {
            vscode.window.showWarningMessage('Egressor: Extension not initialized');
            return;
        }
        const name = await vscode.window.showInputBox({ prompt: 'Secret name (alphanumeric, hyphens, underscores)' });
        if (!name) { return; }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            vscode.window.showErrorMessage('Secret name must contain only alphanumeric characters, hyphens, and underscores');
            return;
        }
        // Look up declaration from current config for accurate metadata
        const config = egressorSetup?.getCurrentConfig();
        const declaration = config?.secrets.find(s => s.name === name)
            ?? { name, type: 'bearer_token' as const, target: '' };
        // Use promptForSecret to collect the correct fields for the secret type
        const fields = await promptForSecret(declaration);
        if (!fields) { return; }
        await provider.storeSecret(declaration, fields);
        vscode.window.showInformationMessage(`Secret '${name}' stored`);
    });

    const deleteSecretCmd = vscode.commands.registerCommand('egressor.deleteSecret', async () => {
        const provider = egressorSetup?.getCredentialProvider();
        if (!provider) {
            vscode.window.showWarningMessage('Egressor: Extension not initialized');
            return;
        }
        const name = await vscode.window.showInputBox({ prompt: 'Secret name to delete (alphanumeric, hyphens, underscores)' });
        if (!name) { return; }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            vscode.window.showErrorMessage('Secret name must contain only alphanumeric characters, hyphens, and underscores');
            return;
        }
        await provider.deleteSecret(name);
        vscode.window.showInformationMessage(`Secret '${name}' deleted`);
    });

    const listSecretsCmd = vscode.commands.registerCommand('egressor.listSecrets', async () => {
        const provider = egressorSetup?.getCredentialProvider();
        if (!provider) {
            vscode.window.showWarningMessage('Egressor: Extension not initialized');
            return;
        }
        const secrets = provider.listSecrets();
        if (secrets.length === 0) {
            vscode.window.showInformationMessage('No secrets stored');
        } else {
            const names = secrets.map(s => s.name).join(', ');
            vscode.window.showInformationMessage(`Stored secrets: ${names}`);
        }
    });

    context.subscriptions.push(startCmd, stopCmd, showSummaryCmd, exportLogCmd, storeSecretCmd, deleteSecretCmd, listSecretsCmd);
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

export async function deactivate(): Promise<void> {
    if (egressorSetup) {
        await egressorSetup.stop();
        egressorSetup.dispose();
        egressorSetup = undefined;
    }
}
