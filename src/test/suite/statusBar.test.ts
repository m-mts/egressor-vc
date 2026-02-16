import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { StatusBarManager } from '../../views/statusBar';
import { DiagnosticsManager } from '../../views/diagnostics';
import { TrafficEvent } from '../../jail/types';

function createTrafficEvent(overrides?: Partial<TrafficEvent>): TrafficEvent {
    return {
        timestamp: new Date('2026-02-16T12:00:00Z'),
        host: 'api.example.com',
        status: 'allowed',
        category: 'http',
        method: 'GET',
        path: '/data',
        port: 443,
        durationMs: 42,
        raw: 'ALLOW GET api.example.com:443 /data 42ms',
        ...overrides,
    };
}

function createMockStatusBarItem() {
    return {
        text: '',
        tooltip: '',
        command: undefined as string | undefined,
        backgroundColor: undefined as unknown,
        show: sinon.stub(),
        hide: sinon.stub(),
        dispose: sinon.stub(),
    };
}

function createMockDiagnosticCollection() {
    return {
        set: sinon.stub(),
        delete: sinon.stub(),
        clear: sinon.stub(),
        dispose: sinon.stub(),
    };
}

// --- StatusBarManager Tests ---

suite('StatusBarManager', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        (vscode.window.createStatusBarItem as sinon.SinonStub).callsFake(() => createMockStatusBarItem());
    });

    teardown(() => {
        sandbox.restore();
    });

    test('creates status bar item on the left side', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        assert.ok(createStub.called);
        assert.strictEqual(createStub.lastCall.args[0], vscode.StatusBarAlignment.Left);
        manager.dispose();
    });

    test('sets click command to focus traffic panel', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;
        assert.strictEqual(item.command, 'egressor.trafficPanel.focus');
        manager.dispose();
    });

    test('shows status bar item on creation', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;
        assert.ok(item.show.calledOnce);
        manager.dispose();
    });

    test('initial counts are zero', () => {
        const manager = new StatusBarManager();
        assert.strictEqual(manager.allowed, 0);
        assert.strictEqual(manager.blocked, 0);
        manager.dispose();
    });

    test('initial text shows zero counts', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;
        assert.ok(item.text.includes('0 allowed'));
        assert.ok(item.text.includes('0 blocked'));
        manager.dispose();
    });

    test('increments allowed count on allowed event', () => {
        const manager = new StatusBarManager();
        manager.onTrafficEvent(createTrafficEvent({ status: 'allowed' }));
        assert.strictEqual(manager.allowed, 1);
        assert.strictEqual(manager.blocked, 0);
        manager.dispose();
    });

    test('increments blocked count on blocked event', () => {
        const manager = new StatusBarManager();
        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked' }));
        assert.strictEqual(manager.allowed, 0);
        assert.strictEqual(manager.blocked, 1);
        manager.dispose();
    });

    test('updates text after events', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({ status: 'allowed' }));
        manager.onTrafficEvent(createTrafficEvent({ status: 'allowed' }));
        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked' }));

        assert.ok(item.text.includes('2 allowed'));
        assert.ok(item.text.includes('1 blocked'));
        manager.dispose();
    });

    test('sets warning background when blocked count > 0', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;

        // Initially no warning background
        assert.strictEqual(item.backgroundColor, undefined);

        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked' }));
        assert.ok(item.backgroundColor !== undefined);
        manager.dispose();
    });

    test('no warning background when no blocked events', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({ status: 'allowed' }));
        assert.strictEqual(item.backgroundColor, undefined);
        manager.dispose();
    });

    test('reset clears counts and updates text', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({ status: 'allowed' }));
        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked' }));
        manager.reset();

        assert.strictEqual(manager.allowed, 0);
        assert.strictEqual(manager.blocked, 0);
        assert.ok(item.text.includes('0 allowed'));
        assert.ok(item.text.includes('0 blocked'));
        assert.strictEqual(item.backgroundColor, undefined);
        manager.dispose();
    });

    test('updates tooltip with current counts', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({ status: 'allowed' }));
        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked' }));

        assert.ok(item.tooltip.includes('1 allowed'));
        assert.ok(item.tooltip.includes('1 blocked'));
        manager.dispose();
    });

    test('dispose disposes the status bar item', () => {
        const manager = new StatusBarManager();
        const createStub = vscode.window.createStatusBarItem as sinon.SinonStub;
        const item = createStub.lastCall.returnValue;

        manager.dispose();
        assert.ok(item.dispose.calledOnce);
    });

    test('handles multiple events of same type', () => {
        const manager = new StatusBarManager();
        for (let i = 0; i < 10; i++) {
            manager.onTrafficEvent(createTrafficEvent({ status: 'allowed' }));
        }
        for (let i = 0; i < 5; i++) {
            manager.onTrafficEvent(createTrafficEvent({ status: 'blocked' }));
        }
        assert.strictEqual(manager.allowed, 10);
        assert.strictEqual(manager.blocked, 5);
        manager.dispose();
    });

    test('handles non-http blocked events', () => {
        const manager = new StatusBarManager();
        manager.onTrafficEvent(createTrafficEvent({
            status: 'blocked',
            category: 'non-http',
            method: undefined,
            path: undefined,
            protocol: 'tcp',
        }));
        assert.strictEqual(manager.blocked, 1);
        manager.dispose();
    });
});

// --- DiagnosticsManager Tests ---

suite('DiagnosticsManager', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        (vscode.languages.createDiagnosticCollection as sinon.SinonStub).callsFake(() => createMockDiagnosticCollection());
    });

    teardown(() => {
        sandbox.restore();
    });

    test('creates diagnostic collection named egressor', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        assert.ok(createStub.called);
        assert.strictEqual(createStub.lastCall.args[0], 'egressor');
        manager.dispose();
    });

    test('ignores allowed events', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        const collection = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({ status: 'allowed' }));

        assert.ok(!collection.set.called);
        manager.dispose();
    });

    test('creates diagnostic for blocked HTTP event', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        const collection = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({
            status: 'blocked',
            method: 'POST',
            host: 'evil.com',
            path: '/steal',
        }));

        assert.ok(collection.set.calledOnce);
        const diagnostics = collection.set.firstCall.args[1];
        assert.strictEqual(diagnostics.length, 1);
        assert.ok(diagnostics[0].message.includes('Blocked POST evil.com/steal'));
        assert.strictEqual(diagnostics[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.strictEqual(diagnostics[0].source, 'Egressor');
        manager.dispose();
    });

    test('creates diagnostic for blocked non-HTTP event', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        const collection = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({
            status: 'blocked',
            category: 'non-http',
            method: undefined,
            path: undefined,
            protocol: 'tcp',
            host: '10.0.0.5',
            port: 3306,
        }));

        assert.ok(collection.set.calledOnce);
        const diagnostics = collection.set.firstCall.args[1];
        assert.strictEqual(diagnostics.length, 1);
        assert.ok(diagnostics[0].message.includes('non-HTTP'));
        assert.ok(diagnostics[0].message.includes('tcp'));
        assert.ok(diagnostics[0].message.includes('10.0.0.5'));
        assert.ok(diagnostics[0].message.includes('3306'));
        manager.dispose();
    });

    test('accumulates blocked events', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        const collection = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked', host: 'a.com' }));
        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked', host: 'b.com' }));
        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked', host: 'c.com' }));

        const lastCall = collection.set.lastCall;
        const diagnostics = lastCall.args[1];
        assert.strictEqual(diagnostics.length, 3);
        manager.dispose();
    });

    test('clear removes all diagnostics', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        const collection = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked' }));
        manager.clear();

        assert.ok(collection.clear.calledOnce);
        assert.strictEqual(manager.events.length, 0);
        manager.dispose();
    });

    test('events getter returns blocked events', () => {
        const manager = new DiagnosticsManager();
        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked', host: 'x.com' }));
        manager.onTrafficEvent(createTrafficEvent({ status: 'allowed', host: 'y.com' }));

        assert.strictEqual(manager.events.length, 1);
        assert.strictEqual(manager.events[0].host, 'x.com');
        manager.dispose();
    });

    test('respects max diagnostics limit', () => {
        const manager = new DiagnosticsManager(3);

        for (let i = 0; i < 5; i++) {
            manager.onTrafficEvent(createTrafficEvent({
                status: 'blocked',
                host: `host${i}.com`,
            }));
        }

        assert.strictEqual(manager.events.length, 3);
        // Should keep the most recent 3
        assert.strictEqual(manager.events[0].host, 'host2.com');
        assert.strictEqual(manager.events[1].host, 'host3.com');
        assert.strictEqual(manager.events[2].host, 'host4.com');
        manager.dispose();
    });

    test('dispose disposes the collection', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        const collection = createStub.lastCall.returnValue;

        manager.dispose();
        assert.ok(collection.dispose.calledOnce);
    });

    test('diagnostic uses egressor URI scheme', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        const collection = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({ status: 'blocked' }));

        const uri = collection.set.firstCall.args[0];
        assert.ok(uri.toString().includes('egressor'));
        manager.dispose();
    });

    test('handles blocked HTTP event without method', () => {
        const manager = new DiagnosticsManager();
        const createStub = vscode.languages.createDiagnosticCollection as sinon.SinonStub;
        const collection = createStub.lastCall.returnValue;

        manager.onTrafficEvent(createTrafficEvent({
            status: 'blocked',
            category: 'http',
            method: undefined,
            host: 'unknown.com',
            path: undefined,
        }));

        const diagnostics = collection.set.firstCall.args[1];
        assert.ok(diagnostics[0].message.includes('UNKNOWN'));
        assert.ok(diagnostics[0].message.includes('unknown.com'));
        manager.dispose();
    });
});
