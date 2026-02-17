import * as assert from 'assert';
import * as sinon from 'sinon';
import { DockerDiscovery, ContainerEvent } from '../../container/docker-discovery';

/**
 * Create a mock Dockerode instance with stubbed methods.
 */
function createMockDocker(sandbox: sinon.SinonSandbox) {
    return {
        ping: sandbox.stub(),
        listContainers: sandbox.stub(),
    };
}

/**
 * Create a fake container info object as returned by dockerode.
 */
function fakeContainerInfo(overrides: {
    Id?: string;
    Names?: string[];
    Image?: string;
    Labels?: Record<string, string>;
    NetworkMode?: string;
} = {}) {
    return {
        Id: overrides.Id ?? 'abc123def456',
        Names: overrides.Names ?? ['/my-container'],
        Image: overrides.Image ?? 'node:18',
        Labels: overrides.Labels ?? {},
        HostConfig: { NetworkMode: overrides.NetworkMode ?? 'bridge' },
    };
}

suite('DockerDiscovery', () => {
    let sandbox: sinon.SinonSandbox;
    let originalHostname: string | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
        originalHostname = process.env.HOSTNAME;
    });

    teardown(() => {
        sandbox.restore();
        if (originalHostname !== undefined) {
            process.env.HOSTNAME = originalHostname;
        } else {
            delete process.env.HOSTNAME;
        }
    });

    suite('isAvailable', () => {
        test('returns true when Docker socket responds to ping', async () => {
            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const available = await discovery.isAvailable();

            assert.strictEqual(available, true);
            assert.ok(docker.ping.calledOnce);
        });

        test('returns false when Docker socket is not available', async () => {
            const docker = createMockDocker(sandbox);
            docker.ping.rejects(new Error('connect ENOENT /var/run/docker.sock'));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const available = await discovery.isAvailable();

            assert.strictEqual(available, false);
        });

        test('caches the availability result', async () => {
            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            await discovery.isAvailable();
            await discovery.isAvailable();

            assert.strictEqual(docker.ping.callCount, 1, 'ping should only be called once');
        });
    });

    suite('listContainers', () => {
        test('returns empty array when Docker is not available', async () => {
            const docker = createMockDocker(sandbox);
            docker.ping.rejects(new Error('no socket'));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const containers = await discovery.listContainers();

            assert.deepStrictEqual(containers, []);
        });

        test('returns discovered containers excluding current container', async () => {
            process.env.HOSTNAME = 'current12char';

            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');
            docker.listContainers.resolves([
                fakeContainerInfo({ Id: 'current12charfull0000', Names: ['/self'] }),
                fakeContainerInfo({ Id: 'sibling123456', Names: ['/web-app'], Image: 'nginx:latest' }),
                fakeContainerInfo({ Id: 'other7890abcd', Names: ['/db'], Image: 'postgres:15', Labels: { env: 'dev' } }),
            ]);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const containers = await discovery.listContainers();

            assert.strictEqual(containers.length, 2);
            assert.strictEqual(containers[0].name, 'web-app');
            assert.strictEqual(containers[0].image, 'nginx:latest');
            assert.strictEqual(containers[1].name, 'db');
            assert.strictEqual(containers[1].labels.env, 'dev');
        });

        test('returns all containers when HOSTNAME is not set', async () => {
            delete process.env.HOSTNAME;

            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');
            docker.listContainers.resolves([
                fakeContainerInfo({ Id: 'abc123', Names: ['/container-a'] }),
                fakeContainerInfo({ Id: 'def456', Names: ['/container-b'] }),
            ]);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const containers = await discovery.listContainers();

            assert.strictEqual(containers.length, 2);
        });

        test('strips leading slash from container names', async () => {
            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');
            docker.listContainers.resolves([
                fakeContainerInfo({ Id: 'abc123', Names: ['/my-service'] }),
            ]);
            delete process.env.HOSTNAME;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const containers = await discovery.listContainers();

            assert.strictEqual(containers[0].name, 'my-service');
        });

        test('maps container info fields correctly', async () => {
            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');
            docker.listContainers.resolves([
                fakeContainerInfo({
                    Id: 'full64charid',
                    Names: ['/app'],
                    Image: 'myapp:v2',
                    Labels: { version: '2', team: 'backend' },
                    NetworkMode: 'host',
                }),
            ]);
            delete process.env.HOSTNAME;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const containers = await discovery.listContainers();

            const c = containers[0];
            assert.strictEqual(c.id, 'full64charid');
            assert.strictEqual(c.name, 'app');
            assert.strictEqual(c.image, 'myapp:v2');
            assert.deepStrictEqual(c.labels, { version: '2', team: 'backend' });
            assert.strictEqual(c.networkMode, 'host');
        });

        test('passes all:false to Docker API to list only running containers', async () => {
            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');
            docker.listContainers.resolves([]);
            delete process.env.HOSTNAME;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            await discovery.listContainers();

            assert.ok(docker.listContainers.calledWith({ all: false }));
        });
    });

    suite('watchContainers', () => {
        test('does nothing when Docker is not available', async () => {
            const docker = createMockDocker(sandbox);
            docker.ping.rejects(new Error('no socket'));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any, pollIntervalMs: 50 });

            await discovery.watchContainers();
            // Should not throw - just returns without starting the poll
            discovery.stopWatching();
        });

        test('emits started event when new container appears', async () => {
            const clock = sandbox.useFakeTimers();
            delete process.env.HOSTNAME;

            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');

            // First call: one container. Second call: two containers.
            docker.listContainers
                .onFirstCall().resolves([
                    fakeContainerInfo({ Id: 'existing1', Names: ['/app'] }),
                ])
                .onSecondCall().resolves([
                    fakeContainerInfo({ Id: 'existing1', Names: ['/app'] }),
                    fakeContainerInfo({ Id: 'newcontainer2', Names: ['/worker'], Image: 'worker:1' }),
                ]);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any, pollIntervalMs: 100 });
            const events: ContainerEvent[] = [];
            discovery.onContainerEvent(e => events.push(e));

            await discovery.watchContainers();

            // Advance timer to trigger first poll
            await clock.tickAsync(100);

            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].type, 'started');
            if (events[0].type === 'started') {
                assert.strictEqual(events[0].container.id, 'newcontainer2');
                assert.strictEqual(events[0].container.name, 'worker');
            }

            discovery.stopWatching();
            clock.restore();
        });

        test('emits stopped event when container disappears', async () => {
            const clock = sandbox.useFakeTimers();
            delete process.env.HOSTNAME;

            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');

            docker.listContainers
                .onFirstCall().resolves([
                    fakeContainerInfo({ Id: 'container1', Names: ['/app'] }),
                    fakeContainerInfo({ Id: 'container2', Names: ['/db'] }),
                ])
                .onSecondCall().resolves([
                    fakeContainerInfo({ Id: 'container1', Names: ['/app'] }),
                ]);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any, pollIntervalMs: 100 });
            const events: ContainerEvent[] = [];
            discovery.onContainerEvent(e => events.push(e));

            await discovery.watchContainers();
            await clock.tickAsync(100);

            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].type, 'stopped');
            if (events[0].type === 'stopped') {
                assert.strictEqual(events[0].containerId, 'container2');
            }

            discovery.stopWatching();
            clock.restore();
        });

        test('stopWatching clears the poll timer and listeners', async () => {
            const clock = sandbox.useFakeTimers();
            delete process.env.HOSTNAME;

            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');
            docker.listContainers.resolves([]);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any, pollIntervalMs: 100 });
            const events: ContainerEvent[] = [];
            discovery.onContainerEvent(e => events.push(e));

            await discovery.watchContainers();
            discovery.stopWatching();

            // Add a new container after stopping
            docker.listContainers.resolves([
                fakeContainerInfo({ Id: 'late-container', Names: ['/late'] }),
            ]);
            await clock.tickAsync(200);

            // No events should fire after stop
            assert.strictEqual(events.length, 0);

            clock.restore();
        });

        test('ignores poll errors gracefully', async () => {
            const clock = sandbox.useFakeTimers();
            delete process.env.HOSTNAME;

            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');

            docker.listContainers
                .onFirstCall().resolves([])
                .onSecondCall().rejects(new Error('Docker daemon unavailable'));

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any, pollIntervalMs: 100 });

            await discovery.watchContainers();

            // Should not throw on poll error
            await clock.tickAsync(100);

            discovery.stopWatching();
            clock.restore();
        });
    });

    suite('current container filtering', () => {
        test('filters container when ID starts with HOSTNAME', async () => {
            process.env.HOSTNAME = 'abc123def456';

            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');
            docker.listContainers.resolves([
                fakeContainerInfo({ Id: 'abc123def456789full64charhexstring', Names: ['/self'] }),
                fakeContainerInfo({ Id: 'other000111222', Names: ['/sibling'] }),
            ]);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const containers = await discovery.listContainers();

            assert.strictEqual(containers.length, 1);
            assert.strictEqual(containers[0].name, 'sibling');
        });

        test('filters container when first 12 chars of ID match HOSTNAME', async () => {
            process.env.HOSTNAME = 'abc123def456';

            const docker = createMockDocker(sandbox);
            docker.ping.resolves('OK');
            docker.listContainers.resolves([
                fakeContainerInfo({ Id: 'abc123def456extrachars', Names: ['/self'] }),
                fakeContainerInfo({ Id: 'xyz789000111', Names: ['/other'] }),
            ]);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const discovery = new DockerDiscovery({ docker: docker as any });
            const containers = await discovery.listContainers();

            assert.strictEqual(containers.length, 1);
            assert.strictEqual(containers[0].name, 'other');
        });
    });
});
