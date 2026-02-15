import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('Egressor');
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('Egressor extension activated');

    const startCmd = vscode.commands.registerCommand('egressor.start', () => {
        outputChannel.appendLine('Egressor: start command invoked');
        vscode.window.showInformationMessage('Egressor started');
    });

    const stopCmd = vscode.commands.registerCommand('egressor.stop', () => {
        outputChannel.appendLine('Egressor: stop command invoked');
        vscode.window.showInformationMessage('Egressor stopped');
    });

    context.subscriptions.push(startCmd, stopCmd);
}

export function deactivate(): void {
    // cleanup will be added in later tasks
}
