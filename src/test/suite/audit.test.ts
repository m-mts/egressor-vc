import * as assert from 'assert';
import { TrafficEvent } from '../../jail/types';
import { SecretInjectionEvent } from '../../secrets/types';
import {
    AuditEntry,
    serializeTrafficEvent,
    serializeSecretInjectionEvent,
} from '../../audit/types';
import { SessionLogger, FileSystemOps } from '../../audit/logger';
import { generateSessionSummary, formatSessionSummary } from '../../audit/summary';

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
        timestamp: new Date('2026-02-16T12:01:00Z'),
        secretName: 'api-key',
        secretType: 'bearer_token',
        target: 'api.example.com',
        success: true,
        raw: 'INJECT api-key -> api.example.com',
        ...overrides,
    };
}

let idCounter = 0;
function testIdGen(): string {
    idCounter++;
    return `test_${idCounter}`;
}

function createMockFsOps(): FileSystemOps & { written: Array<{ path: string; data: string }> } {
    const written: Array<{ path: string; data: string }> = [];
    return {
        written,
        mkdir: async () => {},
        appendFile: async (filePath: string, data: string) => {
            written.push({ path: filePath, data });
        },
        readFile: async (filePath: string) => {
            const lines = written
                .filter(w => w.path === filePath)
                .map(w => w.data)
                .join('');
            return lines;
        },
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        writeFile: async (_filePath: string, _data: string) => {},
    };
}

// --- Serialization Tests ---

suite('AuditTypes - serialization', () => {
    test('serializeTrafficEvent converts Date to ISO string', () => {
        const event = createTrafficEvent();
        const serialized = serializeTrafficEvent(event);
        assert.strictEqual(serialized.timestamp, '2026-02-16T12:00:00.000Z');
        assert.strictEqual(serialized.host, 'api.example.com');
        assert.strictEqual(serialized.method, 'GET');
        assert.strictEqual(serialized.path, '/data');
        assert.strictEqual(serialized.status, 'allowed');
        assert.strictEqual(serialized.category, 'http');
    });

    test('serializeTrafficEvent handles optional fields', () => {
        const event = createTrafficEvent({
            method: undefined,
            path: undefined,
            port: undefined,
            protocol: undefined,
            durationMs: undefined,
        });
        const serialized = serializeTrafficEvent(event);
        assert.strictEqual(serialized.method, undefined);
        assert.strictEqual(serialized.path, undefined);
        assert.strictEqual(serialized.port, undefined);
    });

    test('serializeSecretInjectionEvent converts Date to ISO string', () => {
        const event = createSecretInjectionEvent();
        const serialized = serializeSecretInjectionEvent(event);
        assert.strictEqual(serialized.timestamp, '2026-02-16T12:01:00.000Z');
        assert.strictEqual(serialized.secretName, 'api-key');
        assert.strictEqual(serialized.secretType, 'bearer_token');
        assert.strictEqual(serialized.target, 'api.example.com');
        assert.strictEqual(serialized.success, true);
    });

    test('serializeTrafficEvent preserves container identity fields', () => {
        const event = createTrafficEvent({
            containerId: 'abc123def456',
            containerName: 'my-web-app',
        });
        const serialized = serializeTrafficEvent(event);
        assert.strictEqual(serialized.containerId, 'abc123def456');
        assert.strictEqual(serialized.containerName, 'my-web-app');
    });

    test('serializeTrafficEvent leaves container fields undefined when not set', () => {
        const event = createTrafficEvent();
        const serialized = serializeTrafficEvent(event);
        assert.strictEqual(serialized.containerId, undefined);
        assert.strictEqual(serialized.containerName, undefined);
    });

    test('serializeSecretInjectionEvent preserves container identity fields', () => {
        const event = createSecretInjectionEvent({
            containerId: 'container-789',
            containerName: 'api-service',
        });
        const serialized = serializeSecretInjectionEvent(event);
        assert.strictEqual(serialized.containerId, 'container-789');
        assert.strictEqual(serialized.containerName, 'api-service');
    });

    test('serializeSecretInjectionEvent leaves container fields undefined when not set', () => {
        const event = createSecretInjectionEvent();
        const serialized = serializeSecretInjectionEvent(event);
        assert.strictEqual(serialized.containerId, undefined);
        assert.strictEqual(serialized.containerName, undefined);
    });

    test('TrafficEvent accepts container identity fields', () => {
        const event: TrafficEvent = {
            timestamp: new Date(),
            host: 'example.com',
            status: 'allowed',
            category: 'http',
            raw: 'test',
            containerId: 'ctr-001',
            containerName: 'frontend',
        };
        assert.strictEqual(event.containerId, 'ctr-001');
        assert.strictEqual(event.containerName, 'frontend');
    });

    test('SecretInjectionEvent accepts container identity fields', () => {
        const event: SecretInjectionEvent = {
            timestamp: new Date(),
            secretName: 'db-pass',
            secretType: 'postgresql',
            target: 'db.local',
            success: true,
            raw: 'test',
            containerId: 'ctr-002',
            containerName: 'backend',
        };
        assert.strictEqual(event.containerId, 'ctr-002');
        assert.strictEqual(event.containerName, 'backend');
    });

    test('AuditEntry accepts container identity fields', () => {
        const entry: AuditEntry = {
            id: 'audit-1',
            timestamp: new Date().toISOString(),
            type: 'traffic',
            containerId: 'ctr-003',
            containerName: 'worker',
        };
        assert.strictEqual(entry.containerId, 'ctr-003');
        assert.strictEqual(entry.containerName, 'worker');
    });

    test('AuditEntry container fields are optional', () => {
        const entry: AuditEntry = {
            id: 'audit-2',
            timestamp: new Date().toISOString(),
            type: 'traffic',
        };
        assert.strictEqual(entry.containerId, undefined);
        assert.strictEqual(entry.containerName, undefined);
    });
});

// --- SessionLogger Tests ---

suite('SessionLogger', () => {
    setup(() => {
        idCounter = 0;
    });

    test('start creates log directory and sets initialized state', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();
        assert.ok(logger.isStarted());
        assert.ok(logger.getLogFilePath().startsWith('/tmp/logs/session_'));
        assert.ok(logger.getLogFilePath().endsWith('.jsonl'));
    });

    test('logTrafficEvent writes entry to file and stores in memory', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logTrafficEvent(createTrafficEvent());

        const entries = logger.getEntries();
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].type, 'traffic');
        assert.strictEqual(entries[0].id, 'test_1');
        assert.ok(entries[0].trafficEvent);
        assert.strictEqual(entries[0].trafficEvent!.host, 'api.example.com');

        // Verify file was written
        assert.strictEqual(fsOps.written.length, 1);
        const parsedLine = JSON.parse(fsOps.written[0].data.trim());
        assert.strictEqual(parsedLine.type, 'traffic');
    });

    test('logSecretInjectionEvent writes entry to file and stores in memory', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logSecretInjectionEvent(createSecretInjectionEvent());

        const entries = logger.getEntries();
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].type, 'secret_injection');
        assert.ok(entries[0].secretInjectionEvent);
        assert.strictEqual(entries[0].secretInjectionEvent!.secretName, 'api-key');

        assert.strictEqual(fsOps.written.length, 1);
    });

    test('multiple events are logged in order', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logTrafficEvent(createTrafficEvent({ host: 'a.com' }));
        await logger.logTrafficEvent(createTrafficEvent({ host: 'b.com', status: 'blocked' }));
        await logger.logSecretInjectionEvent(createSecretInjectionEvent());

        const entries = logger.getEntries();
        assert.strictEqual(entries.length, 3);
        assert.strictEqual(entries[0].trafficEvent!.host, 'a.com');
        assert.strictEqual(entries[1].trafficEvent!.host, 'b.com');
        assert.strictEqual(entries[2].type, 'secret_injection');
    });

    test('exportLog returns JSON array of entries', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logTrafficEvent(createTrafficEvent());
        await logger.logSecretInjectionEvent(createSecretInjectionEvent());

        const exported = await logger.exportLog();
        const parsed = JSON.parse(exported);
        assert.ok(Array.isArray(parsed));
        assert.strictEqual(parsed.length, 2);
    });

    test('readLogFile reads JSONL from file', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logTrafficEvent(createTrafficEvent());
        await logger.logTrafficEvent(createTrafficEvent({ host: 'other.com' }));

        const content = await logger.readLogFile();
        const parsed = JSON.parse(content);
        assert.ok(Array.isArray(parsed));
        assert.strictEqual(parsed.length, 2);
    });

    test('readLogFile returns empty array when not started', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);

        const content = await logger.readLogFile();
        assert.strictEqual(content, '[]');
    });

    test('getEntries returns readonly copy', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logTrafficEvent(createTrafficEvent());
        const entries = logger.getEntries();
        assert.strictEqual(entries.length, 1);
    });

    test('getSessionStart returns the session start time', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        const start = logger.getSessionStart();
        assert.ok(start instanceof Date);
    });

    test('logTrafficEvent propagates container identity to AuditEntry', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logTrafficEvent(createTrafficEvent({
            containerId: 'ctr-abc',
            containerName: 'web-frontend',
        }));

        const entries = logger.getEntries();
        assert.strictEqual(entries[0].containerId, 'ctr-abc');
        assert.strictEqual(entries[0].containerName, 'web-frontend');
    });

    test('logSecretInjectionEvent propagates container identity to AuditEntry', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logSecretInjectionEvent(createSecretInjectionEvent({
            containerId: 'ctr-xyz',
            containerName: 'api-backend',
        }));

        const entries = logger.getEntries();
        assert.strictEqual(entries[0].containerId, 'ctr-xyz');
        assert.strictEqual(entries[0].containerName, 'api-backend');
    });

    test('logger entries have no container fields when events lack them', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logTrafficEvent(createTrafficEvent());

        const entries = logger.getEntries();
        assert.strictEqual(entries[0].containerId, undefined);
        assert.strictEqual(entries[0].containerName, undefined);
    });

    test('each entry gets a unique ID', async () => {
        const fsOps = createMockFsOps();
        const logger = new SessionLogger({ logDir: '/tmp/logs' }, fsOps, testIdGen);
        await logger.start();

        await logger.logTrafficEvent(createTrafficEvent());
        await logger.logTrafficEvent(createTrafficEvent());

        const entries = logger.getEntries();
        assert.notStrictEqual(entries[0].id, entries[1].id);
    });
});

// --- Summary Generation Tests ---

suite('SessionSummary - generateSessionSummary', () => {
    const sessionStart = new Date('2026-02-16T12:00:00Z');
    const sessionEnd = new Date('2026-02-16T13:00:00Z');

    function makeEntry(overrides: Partial<AuditEntry>): AuditEntry {
        return {
            id: 'test',
            timestamp: '2026-02-16T12:00:00.000Z',
            type: 'traffic',
            ...overrides,
        };
    }

    test('empty entries returns zero counts', () => {
        const summary = generateSessionSummary([], sessionStart, sessionEnd);
        assert.strictEqual(summary.totalEvents, 0);
        assert.strictEqual(summary.traffic.total, 0);
        assert.strictEqual(summary.traffic.allowed, 0);
        assert.strictEqual(summary.traffic.blocked, 0);
        assert.strictEqual(summary.secretInjections.total, 0);
        assert.strictEqual(summary.topHosts.length, 0);
        assert.strictEqual(summary.anomalies.length, 0);
    });

    test('counts allowed HTTP traffic', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: 'api.com',
                    status: 'allowed',
                    category: 'http',
                    method: 'GET',
                    path: '/',
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.strictEqual(summary.traffic.total, 1);
        assert.strictEqual(summary.traffic.allowed, 1);
        assert.strictEqual(summary.traffic.httpAllowed, 1);
        assert.strictEqual(summary.traffic.blocked, 0);
    });

    test('counts blocked HTTP traffic', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: 'evil.com',
                    status: 'blocked',
                    category: 'http',
                    method: 'POST',
                    path: '/steal',
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.strictEqual(summary.traffic.blocked, 1);
        assert.strictEqual(summary.traffic.httpBlocked, 1);
    });

    test('counts blocked non-HTTP traffic', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: '10.0.0.5',
                    status: 'blocked',
                    category: 'non-http',
                    protocol: 'tcp',
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.strictEqual(summary.traffic.nonHttpBlocked, 1);
    });

    test('counts DNS allowed traffic', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: '8.8.8.8',
                    status: 'allowed',
                    category: 'dns',
                    protocol: 'udp',
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.strictEqual(summary.traffic.dnsAllowed, 1);
    });

    test('counts secret injection events', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'secret_injection',
                secretInjectionEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    secretName: 'api-key',
                    secretType: 'bearer_token',
                    target: 'api.com',
                    success: true,
                    raw: '',
                },
            }),
            makeEntry({
                type: 'secret_injection',
                secretInjectionEvent: {
                    timestamp: '2026-02-16T12:00:01.000Z',
                    secretName: 'db-creds',
                    secretType: 'postgresql',
                    target: 'db.com',
                    success: false,
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.strictEqual(summary.secretInjections.total, 2);
        assert.strictEqual(summary.secretInjections.successful, 1);
        assert.strictEqual(summary.secretInjections.failed, 1);
    });

    test('builds top hosts sorted by count', () => {
        const entries: AuditEntry[] = [];
        for (let i = 0; i < 5; i++) {
            entries.push(makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: 'popular.com',
                    status: 'allowed',
                    category: 'http',
                    raw: '',
                },
            }));
        }
        for (let i = 0; i < 2; i++) {
            entries.push(makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: 'less.com',
                    status: 'allowed',
                    category: 'http',
                    raw: '',
                },
            }));
        }

        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.strictEqual(summary.topHosts.length, 2);
        assert.strictEqual(summary.topHosts[0].host, 'popular.com');
        assert.strictEqual(summary.topHosts[0].count, 5);
        assert.strictEqual(summary.topHosts[1].host, 'less.com');
        assert.strictEqual(summary.topHosts[1].count, 2);
    });

    test('respects maxTopHosts limit', () => {
        const entries: AuditEntry[] = [];
        for (let i = 0; i < 5; i++) {
            entries.push(makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: `host${i}.com`,
                    status: 'allowed',
                    category: 'http',
                    raw: '',
                },
            }));
        }

        const summary = generateSessionSummary(entries, sessionStart, sessionEnd, 2);
        assert.strictEqual(summary.topHosts.length, 2);
    });

    test('detects anomaly: all traffic blocked', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: 'blocked.com',
                    status: 'blocked',
                    category: 'http',
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.ok(summary.anomalies.some(a => a.includes('All traffic was blocked')));
    });

    test('detects anomaly: failed secret injections', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'secret_injection',
                secretInjectionEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    secretName: 'bad',
                    secretType: 'bearer_token',
                    target: 'api.com',
                    success: false,
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.ok(summary.anomalies.some(a => a.includes('secret injection(s) failed')));
    });

    test('detects anomaly: non-HTTP blocked traffic', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: '10.0.0.5',
                    status: 'blocked',
                    category: 'non-http',
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.ok(summary.anomalies.some(a => a.includes('non-HTTP connection(s) blocked')));
    });

    test('calculates duration correctly', () => {
        const summary = generateSessionSummary([], sessionStart, sessionEnd);
        assert.strictEqual(summary.durationMs, 3600000); // 1 hour
    });

    test('no anomalies for normal traffic', () => {
        const entries: AuditEntry[] = [
            makeEntry({
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: 'api.com',
                    status: 'allowed',
                    category: 'http',
                    raw: '',
                },
            }),
        ];
        const summary = generateSessionSummary(entries, sessionStart, sessionEnd);
        assert.strictEqual(summary.anomalies.length, 0);
    });
});

// --- Format Summary Tests ---

suite('SessionSummary - formatSessionSummary', () => {
    test('formats summary as human-readable text', () => {
        const summary = generateSessionSummary(
            [],
            new Date('2026-02-16T12:00:00Z'),
            new Date('2026-02-16T13:00:00Z'),
        );
        const formatted = formatSessionSummary(summary);
        assert.ok(formatted.includes('Egressor Session Summary'));
        assert.ok(formatted.includes('Duration:'));
        assert.ok(formatted.includes('Traffic'));
        assert.ok(formatted.includes('Secret Injections'));
    });

    test('includes anomalies when present', () => {
        const entries: AuditEntry[] = [
            {
                id: 'test',
                timestamp: '2026-02-16T12:00:00.000Z',
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: 'x.com',
                    status: 'blocked',
                    category: 'non-http',
                    raw: '',
                },
            },
        ];
        const summary = generateSessionSummary(
            entries,
            new Date('2026-02-16T12:00:00Z'),
            new Date('2026-02-16T12:05:00Z'),
        );
        const formatted = formatSessionSummary(summary);
        assert.ok(formatted.includes('Anomalies'));
    });

    test('includes top hosts when present', () => {
        const entries: AuditEntry[] = [
            {
                id: 'test',
                timestamp: '2026-02-16T12:00:00.000Z',
                type: 'traffic',
                trafficEvent: {
                    timestamp: '2026-02-16T12:00:00.000Z',
                    host: 'popular.com',
                    status: 'allowed',
                    category: 'http',
                    raw: '',
                },
            },
        ];
        const summary = generateSessionSummary(
            entries,
            new Date('2026-02-16T12:00:00Z'),
            new Date('2026-02-16T12:05:00Z'),
        );
        const formatted = formatSessionSummary(summary);
        assert.ok(formatted.includes('Top Hosts'));
        assert.ok(formatted.includes('popular.com'));
    });

    test('formats duration with hours', () => {
        const summary = generateSessionSummary(
            [],
            new Date('2026-02-16T12:00:00Z'),
            new Date('2026-02-16T14:30:45Z'),
        );
        const formatted = formatSessionSummary(summary);
        assert.ok(formatted.includes('2h 30m 45s'));
    });

    test('formats duration with minutes only', () => {
        const summary = generateSessionSummary(
            [],
            new Date('2026-02-16T12:00:00Z'),
            new Date('2026-02-16T12:05:30Z'),
        );
        const formatted = formatSessionSummary(summary);
        assert.ok(formatted.includes('5m 30s'));
    });
});
