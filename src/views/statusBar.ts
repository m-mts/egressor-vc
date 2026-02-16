import * as vscode from 'vscode';
import { TrafficEvent } from '../jail/types';

export class StatusBarManager implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private allowedCount = 0;
    private blockedCount = 0;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'egressor.trafficPanel.focus';
        this.update();
        this.statusBarItem.show();
    }

    onTrafficEvent(event: TrafficEvent): void {
        if (event.status === 'allowed') {
            this.allowedCount++;
        } else {
            this.blockedCount++;
        }
        this.update();
    }

    reset(): void {
        this.allowedCount = 0;
        this.blockedCount = 0;
        this.update();
    }

    get allowed(): number {
        return this.allowedCount;
    }

    get blocked(): number {
        return this.blockedCount;
    }

    private update(): void {
        if (this.blockedCount > 0) {
            this.statusBarItem.text = `$(shield) Egressor: ${this.allowedCount} allowed / ${this.blockedCount} blocked`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.text = `$(shield) Egressor: ${this.allowedCount} allowed / ${this.blockedCount} blocked`;
            this.statusBarItem.backgroundColor = undefined;
        }
        this.statusBarItem.tooltip = `Egressor Traffic: ${this.allowedCount} allowed, ${this.blockedCount} blocked. Click to open Traffic Panel.`;
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
