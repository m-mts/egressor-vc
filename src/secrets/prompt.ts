import * as vscode from 'vscode';
import { SecretDeclaration } from '../config/types';
import { SecretFields } from './types';
import { CredentialProvider } from './credential-provider';

/**
 * Interface for VS Code window interactions, enabling testability.
 */
export interface WindowApi {
    showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined>;
    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
}

const defaultWindowApi: WindowApi = {
    showInputBox: (opts) => vscode.window.showInputBox(opts),
    showInformationMessage: (msg, ...items) => vscode.window.showInformationMessage(msg, ...items),
    showWarningMessage: (msg, ...items) => vscode.window.showWarningMessage(msg, ...items),
};

/**
 * Prompt the user for a single secret's fields based on its type.
 * Returns the collected fields, or undefined if the user cancelled.
 */
export async function promptForSecret(
    declaration: SecretDeclaration,
    windowApi: WindowApi = defaultWindowApi
): Promise<SecretFields | undefined> {
    const desc = declaration.description
        ? ` (${declaration.description})`
        : '';

    switch (declaration.type) {
        case 'bearer_token': {
            const value = await windowApi.showInputBox({
                prompt: `Enter bearer token for "${declaration.name}"${desc}`,
                password: true,
                ignoreFocusOut: true,
                validateInput: v => v.trim() === '' ? 'Value cannot be empty' : undefined,
            });
            if (value === undefined) {
                return undefined;
            }
            return { value };
        }

        case 'header': {
            const headerName = declaration.headerName ?? 'Authorization';
            const value = await windowApi.showInputBox({
                prompt: `Enter value for header "${headerName}" (secret: "${declaration.name}")${desc}`,
                password: true,
                ignoreFocusOut: true,
                validateInput: v => v.trim() === '' ? 'Value cannot be empty' : undefined,
            });
            if (value === undefined) {
                return undefined;
            }
            return { value };
        }

        case 'basic_auth': {
            const username = await windowApi.showInputBox({
                prompt: `Enter username for "${declaration.name}"${desc}`,
                ignoreFocusOut: true,
                validateInput: v => v.trim() === '' ? 'Username cannot be empty' : undefined,
            });
            if (username === undefined) {
                return undefined;
            }

            const password = await windowApi.showInputBox({
                prompt: `Enter password for "${declaration.name}"${desc}`,
                password: true,
                ignoreFocusOut: true,
                validateInput: v => v.trim() === '' ? 'Password cannot be empty' : undefined,
            });
            if (password === undefined) {
                return undefined;
            }

            return { username, password };
        }

        case 'postgresql':
        case 'mysql': {
            const dbType = declaration.type === 'postgresql' ? 'PostgreSQL' : 'MySQL';

            const host = await windowApi.showInputBox({
                prompt: `Enter ${dbType} host for "${declaration.name}"${desc}`,
                value: declaration.target.split(':')[0],
                ignoreFocusOut: true,
                validateInput: v => v.trim() === '' ? 'Host cannot be empty' : undefined,
            });
            if (host === undefined) {
                return undefined;
            }

            const defaultPort = declaration.type === 'postgresql' ? '5432' : '3306';
            const targetParts = declaration.target.split(':');
            const targetPort = targetParts.length > 1 ? targetParts[targetParts.length - 1] : defaultPort;
            const port = await windowApi.showInputBox({
                prompt: `Enter ${dbType} port for "${declaration.name}"`,
                value: String(targetPort),
                ignoreFocusOut: true,
                validateInput: v => v.trim() === '' ? 'Port cannot be empty' : undefined,
            });
            if (port === undefined) {
                return undefined;
            }

            const username = await windowApi.showInputBox({
                prompt: `Enter ${dbType} username for "${declaration.name}"`,
                ignoreFocusOut: true,
                validateInput: v => v.trim() === '' ? 'Username cannot be empty' : undefined,
            });
            if (username === undefined) {
                return undefined;
            }

            const password = await windowApi.showInputBox({
                prompt: `Enter ${dbType} password for "${declaration.name}"`,
                password: true,
                ignoreFocusOut: true,
                validateInput: v => v.trim() === '' ? 'Password cannot be empty' : undefined,
            });
            if (password === undefined) {
                return undefined;
            }

            return { host, port, username, password };
        }

        default:
            return undefined;
    }
}

/**
 * Detect missing secrets and prompt the user to enter them.
 * Returns the number of secrets successfully collected.
 */
export async function promptForMissingSecrets(
    declarations: SecretDeclaration[],
    credentialProvider: CredentialProvider,
    windowApi: WindowApi = defaultWindowApi
): Promise<number> {
    const missing = await credentialProvider.findMissingSecrets(declarations);
    if (missing.length === 0) {
        return 0;
    }

    const proceed = await windowApi.showWarningMessage(
        `Egressor: ${missing.length} secret(s) need to be configured. Would you like to enter them now?`,
        'Yes',
        'Skip'
    );

    if (proceed !== 'Yes') {
        return 0;
    }

    let collected = 0;
    for (const decl of missing) {
        const fields = await promptForSecret(decl, windowApi);
        if (fields) {
            await credentialProvider.storeSecret(decl, fields);
            collected++;
        }
    }

    if (collected > 0) {
        await windowApi.showInformationMessage(
            `Egressor: ${collected} secret(s) configured successfully.`
        );
    }

    return collected;
}
