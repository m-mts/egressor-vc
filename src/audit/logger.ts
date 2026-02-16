/**
 * Session logger that writes structured JSON audit logs.
 */

import * as path from 'path';
import { TrafficEvent } from '../jail/types';
import { SecretInjectionEvent } from '../secrets/types';
import {
    AuditEntry,
    SessionLoggerOptions,
    serializeTrafficEvent,
    serializeSecretInjectionEvent,
} from './types';

/** Abstraction for filesystem operations (injectable for tests) */
export interface FileSystemOps {
    mkdir(dirPath: string, options: { recursive: boolean }): Promise<void>;
    appendFile(filePath: string, data: string): Promise<void>;
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, data: string): Promise<void>;
}

/** Default filesystem operations using Node's fs/promises */
function defaultFsOps(): FileSystemOps {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs').promises;
    return {
        mkdir: (dirPath: string, options: { recursive: boolean }) => fs.mkdir(dirPath, options),
        appendFile: (filePath: string, data: string) => fs.appendFile(filePath, data, 'utf-8'),
        readFile: (filePath: string) => fs.readFile(filePath, 'utf-8'),
        writeFile: (filePath: string, data: string) => fs.writeFile(filePath, data, 'utf-8'),
    };
}

/** ID generator abstraction (injectable for tests) */
export interface IdGenerator {
    (): string;
}

function createDefaultIdGenerator(): IdGenerator {
    let counter = 0;
    return () => {
        counter++;
        return `evt_${Date.now()}_${counter}`;
    };
}

export class SessionLogger {
    private readonly logDir: string;
    private readonly fsOps: FileSystemOps;
    private readonly idGen: IdGenerator;
    private readonly maxEntries: number;
    private sessionId: string;
    private logFilePath: string;
    private entries: AuditEntry[] = [];
    private sessionStartTime: Date;
    private initialized = false;

    constructor(
        options: SessionLoggerOptions,
        fsOps?: FileSystemOps,
        idGen?: IdGenerator,
    ) {
        this.logDir = options.logDir;
        this.maxEntries = options.maxEntries ?? 10000;
        this.fsOps = fsOps ?? defaultFsOps();
        this.idGen = idGen ?? createDefaultIdGenerator();
        this.sessionId = '';
        this.logFilePath = '';
        this.sessionStartTime = new Date();
    }

    /** Initialize the logger: create log directory and session file */
    async start(): Promise<void> {
        this.sessionStartTime = new Date();
        this.sessionId = `session_${this.sessionStartTime.toISOString().replace(/[:.]/g, '-')}`;
        this.logFilePath = path.join(this.logDir, `${this.sessionId}.jsonl`);
        this.entries = [];

        await this.fsOps.mkdir(this.logDir, { recursive: true });
        this.initialized = true;
    }

    /** Stop the logger and ensure all pending writes are flushed */
    async stop(): Promise<void> {
        this.initialized = false;
    }

    /** Log a traffic event from httpjail */
    async logTrafficEvent(event: TrafficEvent): Promise<void> {
        const entry: AuditEntry = {
            id: this.idGen(),
            timestamp: event.timestamp.toISOString(),
            type: 'traffic',
            trafficEvent: serializeTrafficEvent(event),
        };
        await this.writeEntry(entry);
    }

    /** Log a secret injection event from Secretless Broker */
    async logSecretInjectionEvent(event: SecretInjectionEvent): Promise<void> {
        const entry: AuditEntry = {
            id: this.idGen(),
            timestamp: event.timestamp.toISOString(),
            type: 'secret_injection',
            secretInjectionEvent: serializeSecretInjectionEvent(event),
        };
        await this.writeEntry(entry);
    }

    /** Get all entries logged in this session */
    getEntries(): ReadonlyArray<AuditEntry> {
        return this.entries;
    }

    /** Get the session start time */
    getSessionStart(): Date {
        return this.sessionStartTime;
    }

    /** Get the log file path */
    getLogFilePath(): string {
        return this.logFilePath;
    }

    /** Get whether the logger has been started */
    isStarted(): boolean {
        return this.initialized;
    }

    /** Export the full session log as a JSON string */
    async exportLog(): Promise<string> {
        return JSON.stringify(this.entries, null, 2);
    }

    /** Read the log file contents (for export to a different location) */
    async readLogFile(): Promise<string> {
        if (!this.initialized || !this.logFilePath) {
            return '[]';
        }
        try {
            const content = await this.fsOps.readFile(this.logFilePath);
            // JSONL format: each line is a JSON object
            const lines = content.trim().split('\n').filter(l => l.length > 0);
            const entries = lines.map(line => JSON.parse(line));
            return JSON.stringify(entries, null, 2);
        } catch {
            return '[]';
        }
    }

    /** Write an entry to the in-memory log and append to the log file */
    private async writeEntry(entry: AuditEntry): Promise<void> {
        if (!this.initialized) {
            return;
        }
        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(-this.maxEntries);
        }
        await this.fsOps.appendFile(this.logFilePath, JSON.stringify(entry) + '\n');
    }
}
