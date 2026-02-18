import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    TrafficPanelProvider,
    serializeTrafficEvent,
    serializeSecretEvent,
    FsReadOps,
    HealthCheckDeps,
    ContainerStatusInfo,
} from '../../views/trafficPanel';
import { TrafficEvent } from '../../jail/types';
import { SecretInjectionEvent } from '../../secrets/types';

// --- Helper factories ---

function createMockExtensionUri(): vscode.Uri {
    return vscode.Uri.file('/mock/extension') as vscode.Uri;
}

function createMockFsOps(): FsReadOps {
    return {
        readFileSync: sinon.stub().returns(
            '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="{{cspSource}}"><link rel="stylesheet" href="{{cssUri}}"></head><body><script nonce="{{nonce}}" src="{{scriptUri}}"></script></body></html>'
        ),
    };
}

interface MockWebview {
    options: Record<string, unknown>;
    html: string;
    postMessage: sinon.SinonStub;
    asWebviewUri: sinon.SinonStub;
    cspSource: string;
}

interface MockWebviewView {
    webview: MockWebview;
    visible: boolean;
}

function createMockWebviewView(): MockWebviewView {
    return {
        webview: {
            options: {},
            html: '',
            postMessage: sinon.stub().resolves(true),
            asWebviewUri: sinon.stub().callsFake((uri: { toString: () => string }) => ({
                toString: () => `https://file+.vscode-resource.vscode-cdn.net${uri.toString()}`,
            })),
            cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
        },
        visible: true,
    };
}

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

function createSecretEvent(overrides?: Partial<SecretInjectionEvent>): SecretInjectionEvent {
    return {
        timestamp: new Date('2026-02-16T12:00:00Z'),
        secretName: 'my-api-token',
        secretType: 'bearer_token',
        target: 'api.example.com',
        success: true,
        raw: 'INJECT bearer_token my-api-token api.example.com SUCCESS',
        ...overrides,
    };
}

// --- TrafficPanelProvider Tests ---

suite('TrafficPanelProvider', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('has correct viewType', () => {
        assert.strictEqual(TrafficPanelProvider.viewType, 'egressor.trafficPanel');
    });

    test('resolveWebviewView sets webview options and HTML', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        // Webview options should enable scripts
        assert.strictEqual(mockView.webview.options.enableScripts, true);
        // localResourceRoots should be set
        assert.ok(Array.isArray(mockView.webview.options.localResourceRoots));
        assert.strictEqual((mockView.webview.options.localResourceRoots as unknown[]).length, 2);
        // HTML should be set and have template placeholders replaced
        assert.ok(mockView.webview.html.length > 0);
        assert.ok(!mockView.webview.html.includes('{{cspSource}}'), 'cspSource placeholder should be replaced');
        assert.ok(!mockView.webview.html.includes('{{nonce}}'), 'nonce placeholder should be replaced');
        assert.ok(!mockView.webview.html.includes('{{cssUri}}'), 'cssUri placeholder should be replaced');
        assert.ok(!mockView.webview.html.includes('{{scriptUri}}'), 'scriptUri placeholder should be replaced');
    });

    test('resolveWebviewView reads HTML template from file system', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        assert.ok((fsOps.readFileSync as sinon.SinonStub).calledOnce);
        const callArgs = (fsOps.readFileSync as sinon.SinonStub).firstCall.args;
        assert.ok(callArgs[0].includes('trafficPanel.html'));
        assert.strictEqual(callArgs[1], 'utf8');
    });

    test('postTrafficEvent sends message to webview', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const event = createTrafficEvent();
        provider.postTrafficEvent(event);

        assert.ok(mockView.webview.postMessage.calledOnce);
        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.command, 'trafficEvent');
        assert.strictEqual(message.data.type, 'traffic');
        assert.strictEqual(message.data.host, 'api.example.com');
        assert.strictEqual(message.data.method, 'GET');
        assert.strictEqual(message.data.path, '/data');
        assert.strictEqual(message.data.status, 'allowed');
        assert.strictEqual(message.data.category, 'http');
        assert.strictEqual(message.data.durationMs, 42);
    });

    test('postSecretEvent sends message to webview', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const event = createSecretEvent();
        provider.postSecretEvent(event);

        assert.ok(mockView.webview.postMessage.calledOnce);
        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.command, 'secretEvent');
        assert.strictEqual(message.data.type, 'secret');
        assert.strictEqual(message.data.secretName, 'my-api-token');
        assert.strictEqual(message.data.secretType, 'bearer_token');
        assert.strictEqual(message.data.target, 'api.example.com');
        assert.strictEqual(message.data.success, true);
    });

    test('clearEvents sends clear command to webview', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        provider.clearEvents();

        assert.ok(mockView.webview.postMessage.calledOnce);
        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.command, 'clear');
    });

    test('postTrafficEvent does nothing when view is not resolved', () => {
        const extensionUri = createMockExtensionUri();
        const provider = new TrafficPanelProvider(extensionUri, createMockFsOps());
        // Don't call resolveWebviewView - no view is attached
        const event = createTrafficEvent();
        // Should not throw
        provider.postTrafficEvent(event);
    });

    test('postSecretEvent does nothing when view is not resolved', () => {
        const extensionUri = createMockExtensionUri();
        const provider = new TrafficPanelProvider(extensionUri, createMockFsOps());
        const event = createSecretEvent();
        provider.postSecretEvent(event);
    });

    test('clearEvents does nothing when view is not resolved', () => {
        const extensionUri = createMockExtensionUri();
        const provider = new TrafficPanelProvider(extensionUri, createMockFsOps());
        provider.clearEvents();
    });

    test('isVisible returns false when no view is resolved', () => {
        const extensionUri = createMockExtensionUri();
        const provider = new TrafficPanelProvider(extensionUri, createMockFsOps());
        assert.strictEqual(provider.isVisible, false);
    });

    test('isVisible returns true when view is visible', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();
        mockView.visible = true;

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        assert.strictEqual(provider.isVisible, true);
    });

    test('isVisible returns false when view is not visible', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();
        mockView.visible = false;

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        assert.strictEqual(provider.isVisible, false);
    });

    test('postTrafficEvent serializes blocked event correctly', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const event = createTrafficEvent({ status: 'blocked', host: 'evil.com', category: 'non-http' });
        provider.postTrafficEvent(event);

        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.data.status, 'blocked');
        assert.strictEqual(message.data.host, 'evil.com');
        assert.strictEqual(message.data.category, 'non-http');
    });

    test('postSecretEvent serializes failed injection correctly', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const event = createSecretEvent({ success: false, secretType: 'postgresql' });
        provider.postSecretEvent(event);

        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.data.success, false);
        assert.strictEqual(message.data.secretType, 'postgresql');
    });

    test('HTML template has CSP nonce applied to script tag', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps: FsReadOps = {
            readFileSync: sinon.stub().returns(
                '<html><head><meta content="{{cspSource}}"></head><body><script nonce="{{nonce}}" src="{{scriptUri}}"></script><link href="{{cssUri}}"></body></html>'
            ),
        };
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const html = mockView.webview.html;
        // Nonce should be a 32-char alphanumeric string
        const nonceMatch = html.match(/nonce="([A-Za-z0-9]+)"/);
        assert.ok(nonceMatch, 'HTML should contain a nonce');
        assert.strictEqual(nonceMatch![1].length, 32, 'Nonce should be 32 characters');
        // CSP source should be replaced
        assert.ok(html.includes('https://file+.vscode-resource.vscode-cdn.net'), 'CSP source should be replaced');
    });
});

// --- Serialization Tests ---

suite('Traffic Event Serialization', () => {
    test('serializeTrafficEvent produces correct structure', () => {
        const event = createTrafficEvent();
        const serialized = serializeTrafficEvent(event);

        assert.strictEqual(serialized.type, 'traffic');
        assert.strictEqual(serialized.timestamp, '2026-02-16T12:00:00.000Z');
        assert.strictEqual(serialized.method, 'GET');
        assert.strictEqual(serialized.host, 'api.example.com');
        assert.strictEqual(serialized.path, '/data');
        assert.strictEqual(serialized.port, 443);
        assert.strictEqual(serialized.status, 'allowed');
        assert.strictEqual(serialized.category, 'http');
        assert.strictEqual(serialized.durationMs, 42);
    });

    test('serializeTrafficEvent handles missing optional fields', () => {
        const event = createTrafficEvent({ method: undefined, path: undefined, port: undefined, durationMs: undefined });
        const serialized = serializeTrafficEvent(event);

        assert.strictEqual(serialized.method, undefined);
        assert.strictEqual(serialized.path, undefined);
        assert.strictEqual(serialized.port, undefined);
        assert.strictEqual(serialized.durationMs, undefined);
    });

    test('serializeTrafficEvent handles non-http blocked event', () => {
        const event = createTrafficEvent({
            status: 'blocked',
            category: 'non-http',
            method: undefined,
            path: undefined,
            protocol: 'tcp',
            host: '10.0.0.5',
            port: 3306,
        });
        const serialized = serializeTrafficEvent(event);

        assert.strictEqual(serialized.status, 'blocked');
        assert.strictEqual(serialized.category, 'non-http');
        assert.strictEqual(serialized.protocol, 'tcp');
    });

    test('serializeSecretEvent produces correct structure', () => {
        const event = createSecretEvent();
        const serialized = serializeSecretEvent(event);

        assert.strictEqual(serialized.type, 'secret');
        assert.strictEqual(serialized.timestamp, '2026-02-16T12:00:00.000Z');
        assert.strictEqual(serialized.secretName, 'my-api-token');
        assert.strictEqual(serialized.secretType, 'bearer_token');
        assert.strictEqual(serialized.target, 'api.example.com');
        assert.strictEqual(serialized.success, true);
    });

    test('serializeSecretEvent handles failed injection', () => {
        const event = createSecretEvent({ success: false, secretType: 'mysql' });
        const serialized = serializeSecretEvent(event);

        assert.strictEqual(serialized.success, false);
        assert.strictEqual(serialized.secretType, 'mysql');
    });

    test('serializeSecretEvent handles database secret type', () => {
        const event = createSecretEvent({
            secretName: 'prod-db',
            secretType: 'postgresql',
            target: 'db.example.com:5432',
        });
        const serialized = serializeSecretEvent(event);

        assert.strictEqual(serialized.secretName, 'prod-db');
        assert.strictEqual(serialized.secretType, 'postgresql');
        assert.strictEqual(serialized.target, 'db.example.com:5432');
    });
});

// --- Health Check Tests ---

suite('TrafficPanelProvider Health Check', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    function createHealthCheckDeps(overrides?: Partial<HealthCheckDeps>): HealthCheckDeps {
        return {
            detectHttpjailFn: () => ({ found: true, path: '/usr/bin/httpjail' }),
            detectBrokerBinaryFn: () => ({ found: true, path: '/usr/bin/secretless-broker' }),
            showWarningMessage: sandbox.stub().resolves(undefined) as unknown as typeof vscode.window.showWarningMessage,
            showInformationMessage: sandbox.stub().resolves(undefined) as unknown as typeof vscode.window.showInformationMessage,
            executeCommand: sandbox.stub().resolves(undefined) as unknown as typeof vscode.commands.executeCommand,
            hasSecretsConfig: () => false,
            ...overrides,
        };
    }

    test('shows warning when httpjail is not found', async () => {
        const showWarning = sandbox.stub().resolves(undefined);
        const deps = createHealthCheckDeps({
            detectHttpjailFn: () => ({ found: false }),
            showWarningMessage: showWarning as unknown as typeof vscode.window.showWarningMessage,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);

        await provider.runDependencyHealthCheck();

        assert.ok(showWarning.calledWith(
            'httpjail is not installed. Traffic monitoring requires httpjail.',
            'View Setup Guide'
        ));
    });

    test('opens httpjail docs when user clicks View Setup Guide', async () => {
        const showWarning = sandbox.stub().resolves('View Setup Guide');
        const execCmd = sandbox.stub().resolves(undefined);
        const deps = createHealthCheckDeps({
            detectHttpjailFn: () => ({ found: false }),
            showWarningMessage: showWarning as unknown as typeof vscode.window.showWarningMessage,
            executeCommand: execCmd as unknown as typeof vscode.commands.executeCommand,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);

        await provider.runDependencyHealthCheck();

        assert.ok(execCmd.calledOnce || execCmd.callCount >= 1);
        const firstCall = execCmd.getCalls().find((c: sinon.SinonSpyCall) => c.args[0] === 'markdown.showPreview');
        assert.ok(firstCall, 'Should call markdown.showPreview');
        assert.ok(firstCall!.args[1].path.includes('httpjail-rules.md'));
    });

    test('shows info when httpjail is installed but not running', async () => {
        const showInfo = sandbox.stub().resolves(undefined);
        const mockManager = { getState: () => 'stopped' } as unknown as import('../../jail/manager').HttpjailManager;
        const deps = createHealthCheckDeps({
            detectHttpjailFn: () => ({ found: true, path: '/usr/bin/httpjail' }),
            httpjailManager: mockManager,
            showInformationMessage: showInfo as unknown as typeof vscode.window.showInformationMessage,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);

        await provider.runDependencyHealthCheck();

        assert.ok(showInfo.calledWith(
            'httpjail is installed but not running. Run "Egressor: Start" to begin traffic monitoring.',
        ));
    });

    test('no httpjail notification when installed and running', async () => {
        const showWarning = sandbox.stub().resolves(undefined);
        const showInfo = sandbox.stub().resolves(undefined);
        const mockManager = { getState: () => 'running' } as unknown as import('../../jail/manager').HttpjailManager;
        const deps = createHealthCheckDeps({
            detectHttpjailFn: () => ({ found: true, path: '/usr/bin/httpjail' }),
            httpjailManager: mockManager,
            showWarningMessage: showWarning as unknown as typeof vscode.window.showWarningMessage,
            showInformationMessage: showInfo as unknown as typeof vscode.window.showInformationMessage,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);

        await provider.runDependencyHealthCheck();

        // Warning should not be called for httpjail (only possibly for broker)
        for (const call of showWarning.getCalls()) {
            assert.ok(!call.args[0].includes('httpjail'), 'No httpjail warning when installed and running');
        }
        for (const call of showInfo.getCalls()) {
            assert.ok(!call.args[0].includes('httpjail'), 'No httpjail info when running');
        }
    });

    test('shows warning when secretless-broker is not found', async () => {
        const showWarning = sandbox.stub().resolves(undefined);
        const deps = createHealthCheckDeps({
            detectBrokerBinaryFn: () => ({ found: false }),
            showWarningMessage: showWarning as unknown as typeof vscode.window.showWarningMessage,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);

        await provider.runDependencyHealthCheck();

        const brokerCall = showWarning.getCalls().find(
            (c: sinon.SinonSpyCall) => (c.args[0] as string).includes('Secretless Broker')
        );
        assert.ok(brokerCall, 'Should show warning for missing secretless-broker');
    });

    test('opens broker docs when user clicks View Setup Guide', async () => {
        const showWarning = sandbox.stub().resolves('View Setup Guide');
        const execCmd = sandbox.stub().resolves(undefined);
        const deps = createHealthCheckDeps({
            detectHttpjailFn: () => ({ found: true, path: '/usr/bin/httpjail' }),
            detectBrokerBinaryFn: () => ({ found: false }),
            showWarningMessage: showWarning as unknown as typeof vscode.window.showWarningMessage,
            executeCommand: execCmd as unknown as typeof vscode.commands.executeCommand,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);

        await provider.runDependencyHealthCheck();

        const previewCall = execCmd.getCalls().find(
            (c: sinon.SinonSpyCall) => c.args[0] === 'markdown.showPreview' && c.args[1].path.includes('secretless-broker.md')
        );
        assert.ok(previewCall, 'Should open secretless-broker docs');
    });

    test('shows info when broker is installed but not running and secrets configured', async () => {
        const showInfo = sandbox.stub().resolves(undefined);
        const mockBroker = { getState: () => 'stopped' } as unknown as import('../../secrets/broker-manager').SecretlessBrokerManager;
        const deps = createHealthCheckDeps({
            detectBrokerBinaryFn: () => ({ found: true, path: '/usr/bin/secretless-broker' }),
            brokerManager: mockBroker,
            hasSecretsConfig: () => true,
            showInformationMessage: showInfo as unknown as typeof vscode.window.showInformationMessage,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);

        await provider.runDependencyHealthCheck();

        const brokerCall = showInfo.getCalls().find(
            (c: sinon.SinonSpyCall) => (c.args[0] as string).includes('Secretless Broker')
        );
        assert.ok(brokerCall, 'Should show info for stopped broker with secrets config');
    });

    test('no broker info notification when no secrets configured', async () => {
        const showInfo = sandbox.stub().resolves(undefined);
        const mockBroker = { getState: () => 'stopped' } as unknown as import('../../secrets/broker-manager').SecretlessBrokerManager;
        const deps = createHealthCheckDeps({
            detectBrokerBinaryFn: () => ({ found: true, path: '/usr/bin/secretless-broker' }),
            brokerManager: mockBroker,
            hasSecretsConfig: () => false,
            showInformationMessage: showInfo as unknown as typeof vscode.window.showInformationMessage,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);

        await provider.runDependencyHealthCheck();

        for (const call of showInfo.getCalls()) {
            assert.ok(!(call.args[0] as string).includes('Secretless Broker'), 'No broker info when no secrets configured');
        }
    });

    test('setHealthCheckDeps updates deps used by health check', async () => {
        const showWarning = sandbox.stub().resolves(undefined);
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps());

        // Initially no deps set, use default detection (would call real detectHttpjail)
        // Override with setHealthCheckDeps
        provider.setHealthCheckDeps(createHealthCheckDeps({
            detectHttpjailFn: () => ({ found: false }),
            showWarningMessage: showWarning as unknown as typeof vscode.window.showWarningMessage,
        }));

        await provider.runDependencyHealthCheck();

        assert.ok(showWarning.calledWith(
            'httpjail is not installed. Traffic monitoring requires httpjail.',
            'View Setup Guide'
        ));
    });

    test('resolveWebviewView triggers health check', () => {
        const detectFn = sandbox.stub().returns({ found: true, path: '/usr/bin/httpjail' });
        const detectBrokerFn = sandbox.stub().returns({ found: true, path: '/usr/bin/secretless-broker' });
        const deps = createHealthCheckDeps({
            detectHttpjailFn: detectFn,
            detectBrokerBinaryFn: detectBrokerFn,
        });
        const provider = new TrafficPanelProvider(createMockExtensionUri(), createMockFsOps(), deps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        // Health check is async but should have been called
        // Give the microtask queue a tick to process
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                assert.ok(detectFn.calledOnce, 'detectHttpjail should be called during resolveWebviewView');
                assert.ok(detectBrokerFn.calledOnce, 'detectBrokerBinary should be called during resolveWebviewView');
                resolve();
            }, 10);
        });
    });
});

// --- Container Status Tests ---

suite('TrafficPanelProvider Container Support', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('postContainerStatus sends containerStatus command to webview', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const containers: ContainerStatusInfo[] = [
            { id: 'abc123', name: 'web-app', image: 'node:18', protection: 'egress' },
            { id: 'def456', name: 'api-server', image: 'python:3.11', protection: 'both' },
        ];
        provider.postContainerStatus(containers);

        assert.ok(mockView.webview.postMessage.calledOnce);
        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.command, 'containerStatus');
        assert.ok(Array.isArray(message.data));
        assert.strictEqual(message.data.length, 2);
        assert.strictEqual(message.data[0].name, 'web-app');
        assert.strictEqual(message.data[0].protection, 'egress');
        assert.strictEqual(message.data[1].name, 'api-server');
        assert.strictEqual(message.data[1].protection, 'both');
    });

    test('postContainerStatus does nothing when view is not resolved', () => {
        const extensionUri = createMockExtensionUri();
        const provider = new TrafficPanelProvider(extensionUri, createMockFsOps());
        const containers: ContainerStatusInfo[] = [
            { id: 'abc123', name: 'web-app', image: 'node:18', protection: 'egress' },
        ];
        // Should not throw
        provider.postContainerStatus(containers);
    });

    test('postContainerStatus sends empty array for no containers', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        provider.postContainerStatus([]);

        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.command, 'containerStatus');
        assert.deepStrictEqual(message.data, []);
    });

    test('postTrafficEvent includes container identity fields', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const event = createTrafficEvent({ containerId: 'abc123', containerName: 'web-app' });
        provider.postTrafficEvent(event);

        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.data.containerId, 'abc123');
        assert.strictEqual(message.data.containerName, 'web-app');
    });

    test('postSecretEvent includes container identity fields', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const event = createSecretEvent({ containerId: 'def456', containerName: 'api-server' });
        provider.postSecretEvent(event);

        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.data.containerId, 'def456');
        assert.strictEqual(message.data.containerName, 'api-server');
    });

    test('serializeTrafficEvent includes container fields', () => {
        const event = createTrafficEvent({ containerId: 'abc123', containerName: 'web-app' });
        const serialized = serializeTrafficEvent(event);

        assert.strictEqual(serialized.containerId, 'abc123');
        assert.strictEqual(serialized.containerName, 'web-app');
    });

    test('serializeTrafficEvent omits container fields when not set', () => {
        const event = createTrafficEvent();
        const serialized = serializeTrafficEvent(event);

        assert.strictEqual(serialized.containerId, undefined);
        assert.strictEqual(serialized.containerName, undefined);
    });

    test('serializeSecretEvent includes container fields', () => {
        const event = createSecretEvent({ containerId: 'def456', containerName: 'api-server' });
        const serialized = serializeSecretEvent(event);

        assert.strictEqual(serialized.containerId, 'def456');
        assert.strictEqual(serialized.containerName, 'api-server');
    });

    test('serializeSecretEvent omits container fields when not set', () => {
        const event = createSecretEvent();
        const serialized = serializeSecretEvent(event);

        assert.strictEqual(serialized.containerId, undefined);
        assert.strictEqual(serialized.containerName, undefined);
    });

    test('postContainerStatus sends all protection modes correctly', () => {
        const extensionUri = createMockExtensionUri();
        const fsOps = createMockFsOps();
        const provider = new TrafficPanelProvider(extensionUri, fsOps);
        const mockView = createMockWebviewView();

        provider.resolveWebviewView(
            mockView as unknown as vscode.WebviewView,
            {} as vscode.WebviewViewResolveContext,
            { isCancellationRequested: false, onCancellationRequested: sinon.stub() } as unknown as vscode.CancellationToken
        );

        const containers: ContainerStatusInfo[] = [
            { id: 'a', name: 'c1', image: 'img1', protection: 'egress' },
            { id: 'b', name: 'c2', image: 'img2', protection: 'secrets' },
            { id: 'c', name: 'c3', image: 'img3', protection: 'both' },
            { id: 'd', name: 'c4', image: 'img4', protection: 'none' },
        ];
        provider.postContainerStatus(containers);

        const message = mockView.webview.postMessage.firstCall.args[0];
        assert.strictEqual(message.data[0].protection, 'egress');
        assert.strictEqual(message.data[1].protection, 'secrets');
        assert.strictEqual(message.data[2].protection, 'both');
        assert.strictEqual(message.data[3].protection, 'none');
    });
});
