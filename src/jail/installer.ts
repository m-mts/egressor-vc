import * as vscode from 'vscode';
import * as path from 'path';
import { execSync as nodeExecSync, execFileSync as nodeExecFileSync } from 'child_process';
import * as fs from 'fs';

/** Interface for OS/process operations, enabling testability */
export interface SystemOperations {
    execSync(command: string): string;
    execFileSync(file: string, args: string[]): string;
    platform(): string;
    arch(): string;
    existsSync(filePath: string): boolean;
}

/** Default system operations using Node.js APIs */
const defaultSysOps: SystemOperations = {
    execSync(command: string): string {
        return nodeExecSync(command, { encoding: 'utf-8' }).toString().trim();
    },
    execFileSync(file: string, args: string[]): string {
        return nodeExecFileSync(file, args, { encoding: 'utf-8' }).toString().trim();
    },
    platform(): string {
        return process.platform;
    },
    arch(): string {
        return process.arch;
    },
    existsSync(filePath: string): boolean {
        return fs.existsSync(filePath);
    },
};

/** GitHub release info for httpjail */
export const HTTPJAIL_REPO = 'coder/httpjail';
export const HTTPJAIL_BINARY_NAME = 'httpjail';

/** Possible locations to search for the httpjail binary */
function getSearchPaths(): string[] {
    return [
        '/usr/local/bin/httpjail',
        '/usr/bin/httpjail',
        path.join(process.env.HOME || '/root', '.local', 'bin', 'httpjail'),
    ];
}

/**
 * Result of binary detection.
 */
export interface DetectionResult {
    found: boolean;
    path?: string;
    version?: string;
}

/**
 * Detect if httpjail is installed and return its path and version.
 */
export function detectHttpjail(sysOps: SystemOperations = defaultSysOps): DetectionResult {
    // First try `which` / `where` to find it on PATH
    try {
        const cmd = sysOps.platform() === 'win32' ? 'where httpjail' : 'which httpjail';
        const binaryPath = sysOps.execSync(cmd);
        if (binaryPath) {
            const version = getVersion(binaryPath, sysOps);
            return { found: true, path: binaryPath, version };
        }
    } catch {
        // not on PATH, check known locations
    }

    for (const searchPath of getSearchPaths()) {
        if (sysOps.existsSync(searchPath)) {
            const version = getVersion(searchPath, sysOps);
            return { found: true, path: searchPath, version };
        }
    }

    return { found: false };
}

/**
 * Get the version string from the httpjail binary.
 */
function getVersion(binaryPath: string, sysOps: SystemOperations): string | undefined {
    try {
        const output = sysOps.execFileSync(binaryPath, ['--version']);
        // Extract version from output like "httpjail v0.1.0" or "0.1.0"
        const match = output.match(/v?(\d+\.\d+\.\d+)/);
        return match ? match[1] : output;
    } catch {
        return undefined;
    }
}

/**
 * Build the download URL for a given platform/arch.
 */
export function getDownloadUrl(platform: string, arch: string): string | undefined {
    const platformMap: Record<string, string> = {
        linux: 'linux',
        darwin: 'darwin',
    };
    const archMap: Record<string, string> = {
        x64: 'amd64',
        arm64: 'arm64',
    };

    const osPart = platformMap[platform];
    const archPart = archMap[arch];

    if (!osPart || !archPart) {
        return undefined;
    }

    return `https://github.com/${HTTPJAIL_REPO}/releases/latest/download/httpjail_${osPart}_${archPart}`;
}

/**
 * Prompt the user to install httpjail when it's not found.
 * Returns the path to the installed binary, or undefined if the user declined.
 */
export async function promptInstall(sysOps: SystemOperations = defaultSysOps): Promise<string | undefined> {
    const platform = sysOps.platform();
    const arch = sysOps.arch();
    const downloadUrl = getDownloadUrl(platform, arch);

    if (!downloadUrl) {
        vscode.window.showErrorMessage(
            `httpjail is not available for your platform (${platform}/${arch}). ` +
            `Please install it manually from https://github.com/${HTTPJAIL_REPO}/releases`
        );
        return undefined;
    }

    const choice = await vscode.window.showWarningMessage(
        'httpjail binary not found. It is required for Egressor traffic control.',
        'Install automatically',
        'Install manually',
        'Cancel'
    );

    if (choice === 'Install automatically') {
        return autoInstall(downloadUrl, sysOps);
    } else if (choice === 'Install manually') {
        vscode.window.showInformationMessage(
            `Please download httpjail from https://github.com/${HTTPJAIL_REPO}/releases ` +
            `and place it on your PATH.`
        );
    }

    return undefined;
}

/**
 * Download and install httpjail binary automatically.
 */
async function autoInstall(downloadUrl: string, sysOps: SystemOperations): Promise<string | undefined> {
    const installDir = path.join(process.env.HOME || '/root', '.local', 'bin');
    const installPath = path.join(installDir, HTTPJAIL_BINARY_NAME);

    try {
        sysOps.execFileSync('mkdir', ['-p', installDir]);
        sysOps.execFileSync('curl', ['-fsSL', downloadUrl, '-o', installPath]);
        sysOps.execFileSync('chmod', ['+x', installPath]);

        // Verify installation
        const detection = detectHttpjail(sysOps);
        if (detection.found) {
            vscode.window.showInformationMessage(
                `httpjail installed successfully at ${installPath}` +
                (detection.version ? ` (version ${detection.version})` : '')
            );
            return detection.path;
        }

        vscode.window.showErrorMessage('httpjail was downloaded but could not be verified.');
        return undefined;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to install httpjail: ${message}`);
        return undefined;
    }
}
