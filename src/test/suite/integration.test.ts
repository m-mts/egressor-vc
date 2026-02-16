import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { activate, deactivate, getEgressorSetup } from '../../extension';
import { detectContainer, shouldAutoStart, VscodeEnv } from '../../container/detector';
import { EgressorSetup, SetupOptions } from '../../container/setup';
import { HttpjailManager } from '../../jail/manager';
import { SecretlessBrokerManager } from '../../secrets/broker-manager';
import { SessionLogger, FileSystemOps as LoggerFsOps } from '../../audit/logger';
import { StatusBarManager } from '../../views/statusBar';
import { DiagnosticsManager } from '../../views/diagnostics';
import { TrafficPanelProvider } from '../../views/trafficPanel';
import { ConfigWatcher } from '../../config/watcher';
import { CredentialProvider } from '../../secrets/credential-provider';
import { TrafficEvent } from '../../jail/types';
import { SecretInjectionEvent } from '../../secrets/types';

type StubFn = sinon.SinonStub;

/**
 * Ensure vscode mock stubs have proper behavior configured.
 * Needed because sinon.reset() in other test suites clears .callsFake handlers.
 */
function ensureVscodeMocks(sandbox: sinon.SinonSandbox): void {
    // Re-configure createStatusBarItem if it was reset
    const createSBI = vscode.window.createStatusBarItem as unknown as sinon.SinonStub;
    if (createSBI && typeof createSBI.callsFake === 'function') {
        createSBI.callsFake(() => ({
            text: '',
            tooltip: '',
            command: undefined as string | undefined,
            backgroundColor: undefined as unknown,
            show: sandbox.stub(),
            hide: sandbox.stub(),
            dispose: sandbox.stub(),
        }));
    }

    // Re-configure createDiagnosticCollection
    const createDC = vscode.languages.createDiagnosticCollection as unknown as sinon.SinonStub;
    if (createDC && typeof createDC.returns === 'function') {
        createDC.returns({
            set: sandbox.stub(),
            delete: sandbox.stub(),
            clear: sandbox.stub(),
            dispose: sandbox.stub(),
        });
    }

    // Re-configure createOutputChannel
    const createOC = vscode.window.createOutputChannel as unknown as sinon.SinonStub;
    if (createOC && typeof createOC.returns === 'function') {
        createOC.returns({
            appendLine: sandbox.stub(),
            dispose: sandbox.stub(),
            show: sandbox.stub(),
            clear: sandbox.stub(),
        });
    }

    // Re-configure registerCommand
    const regCmd = vscode.commands.registerCommand as unknown as sinon.SinonStub;
    if (regCmd && typeof regCmd.returns === 'function') {
        regCmd.returns({ dispose: sandbox.stub() });
    }

    // Re-configure registerWebviewViewProvider
    const regWV = vscode.window.registerWebviewViewProvider as unknown as sinon.SinonStub;
    if (regWV && typeof regWV.returns === 'function') {
        regWV.returns({ dispose: sandbox.stub() });
    }
}

// --- Helpers ---

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

function createSecretInjectionEvent(overrides?: Partial<SecretInjectionEvent>): SecretInjectionEvent {
    return {
        timestamp: new Date('2026-02-16T12:00:00Z'),
        secretName: 'my-api-key',
        secretType: 'bearer_token',
        target: 'api.example.com',
        success: true,
        raw: 'INJECT bearer_token my-api-key -> api.example.com',
        ...overrides,
    };
}

function createMockContext(): vscode.ExtensionContext {
    return {
        subscriptions: [],
        globalStorageUri: vscode.Uri.file('/tmp/egressor-test-storage'),
        extensionUri: vscode.Uri.file('/tmp/egressor-extension'),
        secrets: {
            get: sinon.stub().resolves(undefined),
            store: sinon.stub().resolves(),
            delete: sinon.stub().resolves(),
            onDidChange: sinon.stub(),
        },
        globalState: {
            get: sinon.stub().returns([]),
            update: sinon.stub().resolves(),
            keys: sinon.stub().returns([]),
            setKeysForSync: sinon.stub(),
        },
    } as unknown as vscode.ExtensionContext;
}

function createMockLoggerFsOps(): LoggerFsOps {
    return {
        mkdir: sinon.stub().resolves(),
        appendFile: sinon.stub().resolves(),
        readFile: sinon.stub().resolves(''),
        writeFile: sinon.stub().resolves(),
    };
}

// --- Container Detector Tests ---

suite('Container Detector', () => {
    test('detects dev-container remote name', () => {
        const env: VscodeEnv = {
            remoteName: 'dev-container',
            getConfiguration: () => ({ get: () => true }),
            workspaceFolders: [{ uri: vscode.Uri.file('/workspace') }],
        };
        const ctx = detectContainer(env);
        assert.strictEqual(ctx.isContainer, true);
        assert.strictEqual(ctx.remoteName, 'dev-container');
        assert.ok(ctx.workspacePath);
    });

    test('detects devcontainer remote name', () => {
        const env: VscodeEnv = {
            remoteName: 'devcontainer',
            getConfiguration: () => ({ get: () => true }),
            workspaceFolders: [{ uri: vscode.Uri.file('/workspace') }],
        };
        const ctx = detectContainer(env);
        assert.strictEqual(ctx.isContainer, true);
    });

    test('detects attached-container remote name', () => {
        const env: VscodeEnv = {
            remoteName: 'attached-container',
            getConfiguration: () => ({ get: () => true }),
            workspaceFolders: [{ uri: vscode.Uri.file('/workspace') }],
        };
        const ctx = detectContainer(env);
        assert.strictEqual(ctx.isContainer, true);
    });

    test('returns false for non-container environment', () => {
        const env: VscodeEnv = {
            remoteName: undefined,
            getConfiguration: () => ({ get: () => true }),
            workspaceFolders: [{ uri: vscode.Uri.file('/workspace') }],
        };
        const ctx = detectContainer(env);
        assert.strictEqual(ctx.isContainer, false);
        assert.strictEqual(ctx.containerId, undefined);
    });

    test('returns false for SSH remote', () => {
        const env: VscodeEnv = {
            remoteName: 'ssh-remote',
            getConfiguration: () => ({ get: () => true }),
            workspaceFolders: [{ uri: vscode.Uri.file('/workspace') }],
        };
        const ctx = detectContainer(env);
        assert.strictEqual(ctx.isContainer, false);
    });

    test('handles missing workspace folders', () => {
        const env: VscodeEnv = {
            remoteName: 'dev-container',
            getConfiguration: () => ({ get: () => true }),
            workspaceFolders: undefined,
        };
        const ctx = detectContainer(env);
        assert.strictEqual(ctx.isContainer, true);
        assert.strictEqual(ctx.workspacePath, undefined);
    });

    test('shouldAutoStart returns false when autoStart disabled', () => {
        const env: VscodeEnv = {
            remoteName: 'dev-container',
            getConfiguration: () => ({ get: () => false }),
            workspaceFolders: [{ uri: vscode.Uri.file('/workspace') }],
        };
        assert.strictEqual(shouldAutoStart(env), false);
    });

    test('shouldAutoStart returns false when not in container', () => {
        const env: VscodeEnv = {
            remoteName: undefined,
            getConfiguration: () => ({ get: () => true }),
            workspaceFolders: [{ uri: vscode.Uri.file('/workspace') }],
        };
        assert.strictEqual(shouldAutoStart(env), false);
    });
});

// --- EgressorSetup Tests ---

suite('EgressorSetup Orchestrator', () => {
    let sandbox: sinon.SinonSandbox;
    let mockContext: vscode.ExtensionContext;
    let mockOutputChannel: vscode.OutputChannel;
    let mockHttpjail: HttpjailManager;
    let mockBroker: SecretlessBrokerManager;
    let mockSessionLogger: SessionLogger;
    let mockStatusBar: StatusBarManager;
    let mockDiagnostics: DiagnosticsManager;
    let mockTrafficPanel: TrafficPanelProvider;
    let mockConfigWatcher: ConfigWatcher;
    let mockCredProvider: CredentialProvider;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockContext = createMockContext();

        mockOutputChannel = {
            appendLine: sandbox.stub(),
            dispose: sandbox.stub(),
            show: sandbox.stub(),
            clear: sandbox.stub(),
            name: 'Egressor',
        } as unknown as vscode.OutputChannel;

        // Create mock httpjail manager
        mockHttpjail = sandbox.createStubInstance(HttpjailManager) as unknown as HttpjailManager;
        (mockHttpjail.start as sinon.SinonStub).resolves(true);
        (mockHttpjail.stop as sinon.SinonStub).resolves();
        (mockHttpjail.getState as sinon.SinonStub).returns('stopped');
        (mockHttpjail.onTrafficEvent as sinon.SinonStub).returns({ dispose: sandbox.stub() });
        (mockHttpjail.reloadRules as sinon.SinonStub).resolves(true);

        // Create mock broker manager
        mockBroker = sandbox.createStubInstance(SecretlessBrokerManager) as unknown as SecretlessBrokerManager;
        (mockBroker.start as sinon.SinonStub).resolves(true);
        (mockBroker.stop as sinon.SinonStub).resolves();
        (mockBroker.getState as sinon.SinonStub).returns('stopped');
        (mockBroker.onSecretInjection as sinon.SinonStub).returns({ dispose: sandbox.stub() });

        // Create mock session logger
        const loggerFsOps = createMockLoggerFsOps();
        mockSessionLogger = new SessionLogger({ logDir: '/tmp/test-logs' }, loggerFsOps);

        // Re-configure vscode mocks that may have been reset by sinon.reset()
        ensureVscodeMocks(sandbox);

        mockStatusBar = new StatusBarManager();
        mockDiagnostics = new DiagnosticsManager();

        // Create mock traffic panel
        mockTrafficPanel = sandbox.createStubInstance(TrafficPanelProvider) as unknown as TrafficPanelProvider;

        // Create mock config watcher that returns a valid config
        mockConfigWatcher = sandbox.createStubInstance(ConfigWatcher) as unknown as ConfigWatcher;
        (mockConfigWatcher.start as sinon.SinonStub).returns(undefined);
        (mockConfigWatcher.reload as sinon.SinonStub).resolves({
            version: '1',
            rules: [{ host: 'api.example.com' }],
            secrets: [],
        });

        // Create mock credential provider
        mockCredProvider = sandbox.createStubInstance(CredentialProvider) as unknown as CredentialProvider;
        (mockCredProvider.generateSecretFiles as sinon.SinonStub).resolves({});
        (mockCredProvider.findMissingSecrets as sinon.SinonStub).resolves([]);
    });

    teardown(() => {
        mockStatusBar.dispose();
        mockDiagnostics.dispose();
        sandbox.restore();
    });

    function createSetup(overrides?: Partial<SetupOptions>): EgressorSetup {
        return new EgressorSetup({
            context: mockContext,
            outputChannel: mockOutputChannel,
            httpjailManager: mockHttpjail,
            brokerManager: mockBroker,
            sessionLogger: mockSessionLogger,
            statusBar: mockStatusBar,
            diagnostics: mockDiagnostics,
            trafficPanel: mockTrafficPanel,
            configWatcher: mockConfigWatcher,
            credentialProvider: mockCredProvider,
            ...overrides,
        });
    }

    test('initial state is idle', () => {
        const setup = createSetup();
        assert.strictEqual(setup.getState(), 'idle');
        setup.dispose();
    });

    test('start transitions to running on success', async () => {
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace') },
        ];

        const setup = createSetup();
        const result = await setup.start();

        assert.strictEqual(result, true);
        assert.strictEqual(setup.getState(), 'running');

        // Verify httpjail was started
        assert.ok((mockHttpjail.start as sinon.SinonStub).calledOnce);

        // Verify event listeners were wired
        assert.ok((mockHttpjail.onTrafficEvent as sinon.SinonStub).calledOnce);
        assert.ok((mockBroker.onSecretInjection as sinon.SinonStub).calledOnce);

        setup.dispose();
    });

    test('start returns false when config fails to load', async () => {
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace') },
        ];
        (mockConfigWatcher.reload as sinon.SinonStub).resolves(undefined);

        const setup = createSetup();
        const result = await setup.start();

        assert.strictEqual(result, false);
        assert.strictEqual(setup.getState(), 'error');
        setup.dispose();
    });

    test('start returns false when httpjail fails to start', async () => {
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace') },
        ];
        (mockHttpjail.start as sinon.SinonStub).resolves(false);

        const setup = createSetup();
        const result = await setup.start();

        assert.strictEqual(result, false);
        assert.strictEqual(setup.getState(), 'error');
        setup.dispose();
    });

    test('start with secrets triggers broker startup', async () => {
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace') },
        ];
        (mockConfigWatcher.reload as sinon.SinonStub).resolves({
            version: '1',
            rules: [{ host: 'api.example.com' }],
            secrets: [
                { name: 'my-token', type: 'bearer_token', target: 'api.example.com' },
            ],
        });

        const setup = createSetup();
        const result = await setup.start();

        assert.strictEqual(result, true);
        assert.ok((mockBroker.start as sinon.SinonStub).calledOnce);
        assert.ok((mockBroker.writeSecretFiles as sinon.SinonStub).calledOnce);
        setup.dispose();
    });

    test('start without secrets skips broker startup', async () => {
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace') },
        ];

        const setup = createSetup();
        await setup.start();

        assert.ok((mockBroker.start as sinon.SinonStub).notCalled);
        setup.dispose();
    });

    test('stop transitions to idle', async () => {
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace') },
        ];

        const setup = createSetup();
        await setup.start();
        await setup.stop();

        assert.strictEqual(setup.getState(), 'idle');
        assert.ok((mockHttpjail.stop as sinon.SinonStub).calledOnce);
        assert.ok((mockBroker.stop as sinon.SinonStub).calledOnce);
        setup.dispose();
    });

    test('stop when already idle is a no-op', async () => {
        const setup = createSetup();
        await setup.stop();

        assert.strictEqual(setup.getState(), 'idle');
        assert.ok((mockHttpjail.stop as sinon.SinonStub).notCalled);
        setup.dispose();
    });

    test('double start returns true without restarting', async () => {
        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace') },
        ];

        const setup = createSetup();
        await setup.start();
        const result = await setup.start();

        assert.strictEqual(result, true);
        assert.ok((mockHttpjail.start as sinon.SinonStub).calledOnce); // Only once, not twice
        setup.dispose();
    });

    test('dispose cleans up all components', () => {
        const setup = createSetup();
        setup.dispose();

        assert.strictEqual(setup.getState(), 'idle');
        assert.ok((mockHttpjail.dispose as sinon.SinonStub).calledOnce);
        assert.ok((mockBroker.dispose as sinon.SinonStub).calledOnce);
        assert.ok((mockCredProvider.dispose as sinon.SinonStub).calledOnce);
    });

    test('getters return component instances', () => {
        const setup = createSetup();
        assert.strictEqual(setup.getTrafficPanel(), mockTrafficPanel);
        assert.strictEqual(setup.getStatusBar(), mockStatusBar);
        assert.strictEqual(setup.getSessionLogger(), mockSessionLogger);
        assert.strictEqual(setup.getCredentialProvider(), mockCredProvider);
        setup.dispose();
    });
});

// --- Extension Lifecycle Tests ---

suite('Extension Lifecycle (Integration)', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        ensureVscodeMocks(sandbox);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('activate creates output channel and registers commands', () => {
        const fakeOutputChannel = {
            appendLine: sandbox.stub(),
            dispose: sandbox.stub(),
            show: sandbox.stub(),
            clear: sandbox.stub(),
        };
        const fakeDisposable = { dispose: sandbox.stub() };

        // Reset call history and re-configure
        (vscode.window.createOutputChannel as unknown as StubFn).resetHistory();
        (vscode.window.createOutputChannel as unknown as StubFn).returns(fakeOutputChannel);
        (vscode.commands.registerCommand as unknown as StubFn).resetHistory();
        (vscode.commands.registerCommand as unknown as StubFn).returns(fakeDisposable);
        (vscode.window.registerWebviewViewProvider as unknown as StubFn).resetHistory();
        (vscode.window.registerWebviewViewProvider as unknown as StubFn).returns(fakeDisposable);

        const disposables: { dispose(): void }[] = [];
        const context = {
            subscriptions: disposables,
            globalStorageUri: vscode.Uri.file('/tmp/egressor-test-storage'),
            extensionUri: vscode.Uri.file('/tmp/egressor-extension'),
            secrets: {
                get: sandbox.stub().resolves(undefined),
                store: sandbox.stub().resolves(),
                delete: sandbox.stub().resolves(),
                onDidChange: sandbox.stub(),
            },
            globalState: {
                get: sandbox.stub().returns([]),
                update: sandbox.stub().resolves(),
            },
        } as unknown as vscode.ExtensionContext;

        activate(context);

        // Verify output channel created
        const createOutput = vscode.window.createOutputChannel as unknown as StubFn;
        assert.ok(createOutput.calledOnce, 'Should create one output channel');
        assert.strictEqual(createOutput.firstCall.args[0], 'Egressor');

        // Verify commands registered
        const registerCmd = vscode.commands.registerCommand as unknown as StubFn;
        const commandNames = registerCmd.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
        assert.ok(commandNames.includes('egressor.start'));
        assert.ok(commandNames.includes('egressor.stop'));
        assert.ok(commandNames.includes('egressor.showSessionSummary'));
        assert.ok(commandNames.includes('egressor.exportSessionLog'));

        // Verify webview provider registered
        const registerWebview = vscode.window.registerWebviewViewProvider as unknown as StubFn;
        assert.ok(registerWebview.calledOnce);
        assert.strictEqual(registerWebview.firstCall.args[0], 'egressor.trafficPanel');

        // Verify EgressorSetup is accessible
        assert.ok(getEgressorSetup() !== undefined);
    });

    test('deactivate disposes setup', () => {
        ensureVscodeMocks(sandbox);
        const fakeOutputChannel = {
            appendLine: sandbox.stub(),
            dispose: sandbox.stub(),
            show: sandbox.stub(),
            clear: sandbox.stub(),
        };
        const fakeDisposable = { dispose: sandbox.stub() };

        (vscode.window.createOutputChannel as unknown as StubFn).returns(fakeOutputChannel);
        (vscode.commands.registerCommand as unknown as StubFn).returns(fakeDisposable);
        (vscode.window.registerWebviewViewProvider as unknown as StubFn).returns(fakeDisposable);

        const context = {
            subscriptions: [],
            globalStorageUri: vscode.Uri.file('/tmp/egressor-test-storage'),
            extensionUri: vscode.Uri.file('/tmp/egressor-extension'),
            secrets: {
                get: sandbox.stub().resolves(undefined),
                store: sandbox.stub().resolves(),
                delete: sandbox.stub().resolves(),
                onDidChange: sandbox.stub(),
            },
            globalState: {
                get: sandbox.stub().returns([]),
                update: sandbox.stub().resolves(),
            },
        } as unknown as vscode.ExtensionContext;

        activate(context);
        assert.ok(getEgressorSetup() !== undefined);

        deactivate();
        assert.strictEqual(getEgressorSetup(), undefined);
    });

    test('deactivate does not throw when called without activate', () => {
        // Reset state from prior tests
        deactivate();
        assert.doesNotThrow(() => deactivate());
    });
});

// --- Event Wiring Tests ---

suite('Event Wiring (Integration)', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        ensureVscodeMocks(sandbox);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('traffic events flow to all consumers when wired', async () => {
        const mockContext = createMockContext();
        const mockOutputChannel = {
            appendLine: sandbox.stub(),
            dispose: sandbox.stub(),
            show: sandbox.stub(),
            clear: sandbox.stub(),
            name: 'Egressor',
        } as unknown as vscode.OutputChannel;

        // Use real httpjail manager with a mock spawner (won't actually start)
        const trafficListeners: ((event: TrafficEvent) => void)[] = [];
        const mockHttpjail = {
            start: sandbox.stub().resolves(true),
            stop: sandbox.stub().resolves(),
            getState: sandbox.stub().returns('stopped'),
            onTrafficEvent: sandbox.stub().callsFake((listener: (event: TrafficEvent) => void) => {
                trafficListeners.push(listener);
                return { dispose: sandbox.stub() };
            }),
            reloadRules: sandbox.stub().resolves(true),
            dispose: sandbox.stub(),
        } as unknown as HttpjailManager;

        const secretListeners: ((event: SecretInjectionEvent) => void)[] = [];
        const mockBroker = {
            start: sandbox.stub().resolves(true),
            stop: sandbox.stub().resolves(),
            getState: sandbox.stub().returns('stopped'),
            onSecretInjection: sandbox.stub().callsFake((listener: (event: SecretInjectionEvent) => void) => {
                secretListeners.push(listener);
                return { dispose: sandbox.stub() };
            }),
            writeSecretFiles: sandbox.stub(),
            dispose: sandbox.stub(),
        } as unknown as SecretlessBrokerManager;

        const loggerFsOps = createMockLoggerFsOps();
        const sessionLogger = new SessionLogger({ logDir: '/tmp/test-logs' }, loggerFsOps);

        const statusBar = new StatusBarManager();
        const diagnostics = new DiagnosticsManager();
        const trafficPanel = sandbox.createStubInstance(TrafficPanelProvider) as unknown as TrafficPanelProvider;

        const mockConfigWatcher = {
            start: sandbox.stub(),
            reload: sandbox.stub().resolves({
                version: '1',
                rules: [{ host: 'api.example.com' }],
                secrets: [],
            }),
            dispose: sandbox.stub(),
        } as unknown as ConfigWatcher;

        const mockCredProvider = {
            generateSecretFiles: sandbox.stub().resolves({}),
            findMissingSecrets: sandbox.stub().resolves([]),
            dispose: sandbox.stub(),
        } as unknown as CredentialProvider;

        (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
            { uri: vscode.Uri.file('/workspace') },
        ];

        const setup = new EgressorSetup({
            context: mockContext,
            outputChannel: mockOutputChannel,
            httpjailManager: mockHttpjail,
            brokerManager: mockBroker,
            sessionLogger,
            statusBar,
            diagnostics,
            trafficPanel,
            configWatcher: mockConfigWatcher,
            credentialProvider: mockCredProvider,
        });

        await setup.start();

        // Simulate a traffic event
        const event = createTrafficEvent({ status: 'blocked' });
        assert.strictEqual(trafficListeners.length, 1);
        trafficListeners[0](event);

        // Verify it reached all consumers
        assert.ok((trafficPanel.postTrafficEvent as sinon.SinonStub).calledOnce);
        assert.strictEqual(statusBar.blocked, 1);
        assert.strictEqual(diagnostics.events.length, 1);
        assert.strictEqual(sessionLogger.getEntries().length, 1);

        // Simulate a secret injection event
        const secretEvent = createSecretInjectionEvent();
        assert.strictEqual(secretListeners.length, 1);
        secretListeners[0](secretEvent);

        // Verify secret event reached consumers
        assert.ok((trafficPanel.postSecretEvent as sinon.SinonStub).calledOnce);
        assert.strictEqual(sessionLogger.getEntries().length, 2);

        statusBar.dispose();
        diagnostics.dispose();
        setup.dispose();
    });
});
