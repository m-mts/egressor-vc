/**
 * Detects when a devcontainer opens and provides container context information.
 */

import * as vscode from 'vscode';

/** Information about the detected container environment */
export interface ContainerContext {
    /** Whether we are running inside a container */
    isContainer: boolean;
    /** The container ID (if detectable) */
    containerId?: string;
    /** The remote name (e.g., 'dev-container', 'attached-container') */
    remoteName?: string;
    /** The workspace folder path inside the container */
    workspacePath?: string;
}

/** Interface for VS Code environment access (testable) */
export interface VscodeEnv {
    remoteName: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConfiguration(section: string): { get(key: string): any };
    workspaceFolders: readonly { uri: vscode.Uri }[] | undefined;
}

/** Default VS Code environment implementation */
const defaultVscodeEnv: VscodeEnv = {
    get remoteName() {
        return vscode.env.remoteName;
    },
    getConfiguration(section: string) {
        return vscode.workspace.getConfiguration(section);
    },
    get workspaceFolders() {
        return vscode.workspace.workspaceFolders;
    },
};

/**
 * Detect if we are running inside a devcontainer or remote container.
 */
export function detectContainer(env: VscodeEnv = defaultVscodeEnv): ContainerContext {
    const remoteName = env.remoteName;
    const isContainer = remoteName === 'dev-container'
        || remoteName === 'attached-container'
        || remoteName === 'devcontainer';

    const workspacePath = env.workspaceFolders?.[0]?.uri.fsPath;

    // Try to get container ID from environment variable
    const containerId = process.env.HOSTNAME || undefined;

    return {
        isContainer,
        containerId: isContainer ? containerId : undefined,
        remoteName,
        workspacePath,
    };
}

/**
 * Check if a .egressor.yml config file exists in the workspace.
 */
export function hasEgressorConfig(env: VscodeEnv = defaultVscodeEnv): boolean {
    const workspacePath = env.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        return false;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs');
        return fs.existsSync(`${workspacePath}/.egressor.yml`);
    } catch {
        return false;
    }
}

/**
 * Determine if auto-start should be triggered.
 * Auto-starts when:
 * 1. Running in a container context, AND
 * 2. A .egressor.yml file exists in the workspace, AND
 * 3. The autoStart setting is enabled (default: true)
 */
export function shouldAutoStart(env: VscodeEnv = defaultVscodeEnv): boolean {
    const autoStart = env.getConfiguration('egressor').get('autoStart');
    if (autoStart === false) {
        return false;
    }
    const container = detectContainer(env);
    if (!container.isContainer) {
        return false;
    }
    return hasEgressorConfig(env);
}
