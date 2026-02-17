import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ContainerOrchestrator, ManagerFactory } from '../../container/orchestrator';
import { DockerDiscovery, DiscoveredContainer, ContainerEventListener } from '../../container/docker-discovery';
import { ResolvedConfig } from '../../config/types';
import { HttpjailManager } from '../../jail/manager';
import { SecretlessBrokerManager } from '../../secrets/broker-manager';
import { TrafficEvent } from '../../jail/types';
import { SecretInjectionEvent } from '../../secrets/types';

/** Create a minimal output channel stub */
function createOutputChannel(): vscode.OutputChannel {
    return {
        name: 'test',
        append: sinon.stub(),
        appendLine: sinon.stub(),
        replace: sinon.stub(),
        clear: sinon.stub(),
        show: sinon.stub(),
        hide: sinon.stub(),
        dispose: sinon.stub(),
    } as unknown as vscode.OutputChannel;
}

/** Create a mock DockerDiscovery */
function createMockDiscovery(options: {
    available?: boolean;
    containers?: DiscoveredContainer[];
} = {}): DockerDiscovery & {
    eventListeners: ContainerEventListener[];
    emitContainerEvent: (event: { type: 'started'; container: DiscoveredContainer } | { type: 'stopped'; containerId: string }) => void;
} {
    const eventListeners: ContainerEventListener[] = [];
    const discovery = {
        eventListeners,
        isAvailable: sinon.stub().resolves(options.available ?? true),
        listContainers: sinon.stub().resolves(options.containers ?? []),
        watchContainers: sinon.stub().resolves(),
        stopWatching: sinon.stub(),
        onContainerEvent: (listener: ContainerEventListener) => {
            eventListeners.push(listener);
        },
        emitContainerEvent: (event: { type: 'started'; container: DiscoveredContainer } | { type: 'stopped'; containerId: string }) => {
            for (const l of eventListeners) { l(event); }
        },
    } as unknown as DockerDiscovery & {
        eventListeners: ContainerEventListener[];
        emitContainerEvent: (event: { type: 'started'; container: DiscoveredContainer } | { type: 'stopped'; containerId: string }) => void;
    };
    return discovery;
}

/** Create a mock HttpjailManager */
function createMockHttpjailManager(): HttpjailManager {
    let trafficListener: ((event: TrafficEvent) => void) | undefined;
    return {
        start: sinon.stub().resolves(true),
        stop: sinon.stub().resolves(),
        dispose: sinon.stub(),
        onTrafficEvent: sinon.stub().callsFake((listener: (event: TrafficEvent) => void) => {
            trafficListener = listener;
            return { dispose: sinon.stub() };
        }),
        getState: sinon.stub().returns('running'),
        _emitTraffic: (event: TrafficEvent) => { trafficListener?.(event); },
    } as unknown as HttpjailManager & { _emitTraffic: (event: TrafficEvent) => void };
}

/** Create a mock SecretlessBrokerManager */
function createMockBrokerManager(): SecretlessBrokerManager {
    let secretListener: ((event: SecretInjectionEvent) => void) | undefined;
    return {
        start: sinon.stub().resolves(true),
        stop: sinon.stub().resolves(),
        dispose: sinon.stub(),
        onSecretInjection: sinon.stub().callsFake((listener: (event: SecretInjectionEvent) => void) => {
            secretListener = listener;
            return { dispose: sinon.stub() };
        }),
        getState: sinon.stub().returns('running'),
        _emitSecret: (event: SecretInjectionEvent) => { secretListener?.(event); },
    } as unknown as SecretlessBrokerManager & { _emitSecret: (event: SecretInjectionEvent) => void };
}

/** Create a mock ManagerFactory that returns provided mocks */
function createMockFactory(httpjailManagers: HttpjailManager[], brokerManagers: SecretlessBrokerManager[]): ManagerFactory {
    let httpIdx = 0;
    let brokerIdx = 0;
    return {
        createHttpjailManager: () => httpjailManagers[httpIdx++] ?? createMockHttpjailManager(),
        createBrokerManager: () => brokerManagers[brokerIdx++] ?? createMockBrokerManager(),
    };
}

/** A sample discovered container */
function sampleContainer(overrides: Partial<DiscoveredContainer> = {}): DiscoveredContainer {
    return {
        id: 'abc123def456',
        name: 'my-api',
        image: 'node:18',
        labels: {},
        networkMode: 'bridge',
        ...overrides,
    };
}

/** A config with one container config entry */
function configWithContainers(containers: ResolvedConfig['containers']): ResolvedConfig {
    return {
        version: '1',
        rules: [{ host: 'example.com' }],
        secrets: [],
        containers,
    };
}

suite('ContainerOrchestrator', () => {
    let sandbox: sinon.SinonSandbox;
    let outputChannel: vscode.OutputChannel;

    setup(() => {
        sandbox = sinon.createSandbox();
        outputChannel = createOutputChannel();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('skips when no container configs defined', async () => {
        const discovery = createMockDiscovery();
        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
        });

        await orchestrator.start(configWithContainers([]));

        assert.strictEqual(orchestrator.getEnforcements().size, 0);
        sinon.assert.notCalled(discovery.listContainers as sinon.SinonStub);

        orchestrator.dispose();
    });

    test('skips when Docker is not available', async () => {
        const discovery = createMockDiscovery({ available: false });
        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api' },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 0);

        orchestrator.dispose();
    });

    test('matches container by name and sets up httpjail', async () => {
        const container = sampleContainer({ name: 'my-api' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api' },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);

        assert.strictEqual(orchestrator.getEnforcements().size, 1);
        const enforcement = orchestrator.getEnforcements().get(container.id);
        assert.ok(enforcement);
        assert.strictEqual(enforcement!.containerName, 'my-api');
        assert.strictEqual(enforcement!.configName, 'api');
        assert.ok(enforcement!.httpjailManager);
        assert.strictEqual(enforcement!.brokerManager, undefined);

        sinon.assert.calledOnce(mockHttpjail.start as sinon.SinonStub);
        const startArgs = (mockHttpjail.start as sinon.SinonStub).firstCall.args[0];
        assert.ok(startArgs.rulesFilePath.includes('httpjail-rules-api.js'));
        assert.strictEqual(startArgs.containerId, container.id);

        orchestrator.dispose();
    });

    test('matches container by image glob pattern', async () => {
        const container = sampleContainer({ image: 'node:18-alpine' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'node-app',
            match: { image: 'node*' },
            rules: [{ host: 'npmjs.org' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 1);

        orchestrator.dispose();
    });

    test('matches container by labels', async () => {
        const container = sampleContainer({ labels: { 'egressor.protect': 'true', env: 'dev' } });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'labeled',
            match: { label: { 'egressor.protect': 'true' } },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 1);

        orchestrator.dispose();
    });

    test('does not match container when labels do not match', async () => {
        const container = sampleContainer({ labels: { env: 'dev' } });
        const discovery = createMockDiscovery({ containers: [container] });
        const factory = createMockFactory([], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'labeled',
            match: { label: { 'egressor.protect': 'true' } },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 0);

        orchestrator.dispose();
    });

    test('sets up broker when container has secrets', async () => {
        const container = sampleContainer({ name: 'my-api' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail = createMockHttpjailManager();
        const mockBroker = createMockBrokerManager();
        const factory = createMockFactory([mockHttpjail], [mockBroker]);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api' },
            rules: [{ host: 'example.com' }],
            secrets: [{ name: 'api-key', type: 'bearer_token', target: 'api.example.com' }],
        }]);

        await orchestrator.start(config);

        const enforcement = orchestrator.getEnforcements().get(container.id);
        assert.ok(enforcement);
        assert.ok(enforcement!.httpjailManager);
        assert.ok(enforcement!.brokerManager);

        sinon.assert.calledOnce(mockBroker.start as sinon.SinonStub);
        const brokerArgs = (mockBroker.start as sinon.SinonStub).firstCall.args[0];
        assert.ok(brokerArgs.configFilePath.includes('secretless-api.yml'));

        orchestrator.dispose();
    });

    test('emits traffic events with container identity', async () => {
        const container = sampleContainer({ name: 'my-api', id: 'container-123' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail = createMockHttpjailManager() as HttpjailManager & { _emitTraffic: (e: TrafficEvent) => void };
        const factory = createMockFactory([mockHttpjail], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api' },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);

        const receivedEvents: { event: TrafficEvent; containerId: string; containerName: string }[] = [];
        orchestrator.onTrafficEvent((event, containerId, containerName) => {
            receivedEvents.push({ event, containerId, containerName });
        });

        const trafficEvent: TrafficEvent = {
            timestamp: new Date(),
            host: 'example.com',
            status: 'allowed',
            category: 'http',
            raw: 'ALLOW GET example.com',
        };
        mockHttpjail._emitTraffic(trafficEvent);

        assert.strictEqual(receivedEvents.length, 1);
        assert.strictEqual(receivedEvents[0].containerId, 'container-123');
        assert.strictEqual(receivedEvents[0].containerName, 'my-api');
        assert.strictEqual(receivedEvents[0].event.host, 'example.com');

        orchestrator.dispose();
    });

    test('emits secret events with container identity', async () => {
        const container = sampleContainer({ name: 'my-api', id: 'container-456' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockBroker = createMockBrokerManager() as SecretlessBrokerManager & { _emitSecret: (e: SecretInjectionEvent) => void };
        const factory = createMockFactory([], [mockBroker]);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api' },
            rules: [],
            secrets: [{ name: 'token', type: 'bearer_token', target: 'api.example.com' }],
        }]);

        await orchestrator.start(config);

        const receivedEvents: { event: SecretInjectionEvent; containerId: string; containerName: string }[] = [];
        orchestrator.onSecretEvent((event, containerId, containerName) => {
            receivedEvents.push({ event, containerId, containerName });
        });

        const secretEvent: SecretInjectionEvent = {
            timestamp: new Date(),
            secretName: 'token',
            secretType: 'bearer_token',
            target: 'api.example.com',
            success: true,
            raw: 'injected token',
        };
        mockBroker._emitSecret(secretEvent);

        assert.strictEqual(receivedEvents.length, 1);
        assert.strictEqual(receivedEvents[0].containerId, 'container-456');
        assert.strictEqual(receivedEvents[0].containerName, 'my-api');

        orchestrator.dispose();
    });

    test('handles container start event and sets up enforcement', async () => {
        const discovery = createMockDiscovery({ containers: [] });
        const mockHttpjail = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api' },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 0);

        // Simulate a new container appearing
        const newContainer = sampleContainer({ name: 'my-api', id: 'new-container-id' });
        discovery.emitContainerEvent({ type: 'started', container: newContainer });

        // Wait for async handling
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(orchestrator.getEnforcements().size, 1);
        assert.ok(orchestrator.getEnforcements().has('new-container-id'));

        orchestrator.dispose();
    });

    test('handles container stop event and tears down enforcement', async () => {
        const container = sampleContainer({ name: 'my-api', id: 'container-to-stop' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api' },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 1);

        // Simulate container stopping
        discovery.emitContainerEvent({ type: 'stopped', containerId: 'container-to-stop' });

        // Wait for async handling
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(orchestrator.getEnforcements().size, 0);
        sinon.assert.calledOnce(mockHttpjail.stop as sinon.SinonStub);

        orchestrator.dispose();
    });

    test('stop() tears down all enforcements', async () => {
        const container1 = sampleContainer({ name: 'api-1', id: 'id-1' });
        const container2 = sampleContainer({ name: 'api-2', id: 'id-2' });
        const discovery = createMockDiscovery({ containers: [container1, container2] });
        const mockHttpjail1 = createMockHttpjailManager();
        const mockHttpjail2 = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail1, mockHttpjail2], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([
            { name: 'api1', match: { name: 'api-1' }, rules: [{ host: 'a.com' }], secrets: [] },
            { name: 'api2', match: { name: 'api-2' }, rules: [{ host: 'b.com' }], secrets: [] },
        ]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 2);

        await orchestrator.stop();

        assert.strictEqual(orchestrator.getEnforcements().size, 0);
        sinon.assert.calledOnce(mockHttpjail1.stop as sinon.SinonStub);
        sinon.assert.calledOnce(mockHttpjail2.stop as sinon.SinonStub);

        orchestrator.dispose();
    });

    test('does not match container with no match criteria', async () => {
        const container = sampleContainer();
        const discovery = createMockDiscovery({ containers: [container] });
        const factory = createMockFactory([], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'empty-match',
            match: {},
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 0);

        orchestrator.dispose();
    });

    test('does not set up duplicate enforcement for same container', async () => {
        const container = sampleContainer({ name: 'my-api', id: 'dup-id' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api' },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 1);

        // Try to start same container again
        discovery.emitContainerEvent({ type: 'started', container });
        await new Promise(resolve => setTimeout(resolve, 10));

        // Should still be 1
        assert.strictEqual(orchestrator.getEnforcements().size, 1);
        sinon.assert.calledOnce(mockHttpjail.start as sinon.SinonStub);

        orchestrator.dispose();
    });

    test('updateConfig tears down no-longer-matching and sets up new matches', async () => {
        const container = sampleContainer({ name: 'my-api', id: 'update-id' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail1 = createMockHttpjailManager();
        const mockHttpjail2 = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail1, mockHttpjail2], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config1 = configWithContainers([{
            name: 'old-api',
            match: { name: 'my-api' },
            rules: [{ host: 'old.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config1);
        assert.strictEqual(orchestrator.getEnforcements().size, 1);

        // Update config to a different config name
        const config2 = configWithContainers([{
            name: 'new-api',
            match: { name: 'my-api' },
            rules: [{ host: 'new.com' }],
            secrets: [],
        }]);

        await orchestrator.updateConfig(config2);

        // Old enforcement should be torn down, new one set up
        sinon.assert.calledOnce(mockHttpjail1.stop as sinon.SinonStub);
        assert.strictEqual(orchestrator.getEnforcements().size, 1);
        const enforcement = orchestrator.getEnforcements().get('update-id');
        assert.ok(enforcement);
        assert.strictEqual(enforcement!.configName, 'new-api');

        orchestrator.dispose();
    });

    test('glob matching with wildcard suffix', async () => {
        const container = sampleContainer({ name: 'my-api-prod' });
        const discovery = createMockDiscovery({ containers: [container] });
        const mockHttpjail = createMockHttpjailManager();
        const factory = createMockFactory([mockHttpjail], []);

        const orchestrator = new ContainerOrchestrator({
            outputChannel,
            discovery,
            outputDir: '/tmp/out',
            secretsDir: '/tmp/secrets',
            managerFactory: factory,
        });

        const config = configWithContainers([{
            name: 'api',
            match: { name: 'my-api*' },
            rules: [{ host: 'example.com' }],
            secrets: [],
        }]);

        await orchestrator.start(config);
        assert.strictEqual(orchestrator.getEnforcements().size, 1);

        orchestrator.dispose();
    });
});
