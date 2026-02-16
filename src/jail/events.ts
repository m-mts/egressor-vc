import { TrafficEvent } from './types';

/**
 * Parse httpjail stdout/stderr lines into structured TrafficEvent objects.
 *
 * httpjail outputs traffic logs in various formats depending on the event type:
 * - HTTP allowed:  "ALLOW GET registry.npmjs.org:443 /package/foo 12ms"
 * - HTTP blocked:  "BLOCK POST api.evil.com:443 /exfiltrate"
 * - Non-HTTP blocked: "BLOCK-TCP 10.0.0.5:3306 (non-HTTP)"
 * - DNS allowed:   "DNS registry.npmjs.org -> 104.16.0.35"
 *
 * These patterns are based on httpjail's log output format.
 */

/** Regex patterns for different httpjail log line types */
const HTTP_ALLOW_PATTERN = /^ALLOW\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^:\s]+)(?::(\d+))?\s+(\S+)(?:\s+(\d+)ms)?/;
const HTTP_BLOCK_PATTERN = /^BLOCK\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^:\s]+)(?::(\d+))?(?:\s+(\S+))?/;
const NON_HTTP_BLOCK_PATTERN = /^BLOCK-TCP\s+([^:\s]+)(?::(\d+))?\s+\(non-HTTP\)/;
const DNS_PATTERN = /^DNS\s+(\S+)\s+->\s+(\S+)/;
const CONNECT_ALLOW_PATTERN = /^ALLOW\s+CONNECT\s+([^:\s]+)(?::(\d+))?$/;
const CONNECT_BLOCK_PATTERN = /^BLOCK\s+CONNECT\s+([^:\s]+)(?::(\d+))?$/;

/**
 * Parse a single httpjail log line into a TrafficEvent.
 * Returns undefined if the line doesn't match any known pattern.
 */
export function parseLogLine(line: string): TrafficEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
        return undefined;
    }

    let match: RegExpMatchArray | null;

    // HTTP allowed request
    match = trimmed.match(HTTP_ALLOW_PATTERN);
    if (match) {
        return {
            timestamp: new Date(),
            method: match[1],
            host: match[2],
            port: match[3] ? parseInt(match[3], 10) : undefined,
            path: match[4],
            status: 'allowed',
            category: 'http',
            protocol: 'https',
            durationMs: match[5] ? parseInt(match[5], 10) : undefined,
            raw: trimmed,
        };
    }

    // HTTP blocked request
    match = trimmed.match(HTTP_BLOCK_PATTERN);
    if (match) {
        return {
            timestamp: new Date(),
            method: match[1],
            host: match[2],
            port: match[3] ? parseInt(match[3], 10) : undefined,
            path: match[4] || '/',
            status: 'blocked',
            category: 'http',
            protocol: 'https',
            raw: trimmed,
        };
    }

    // CONNECT allowed (HTTPS tunnel)
    match = trimmed.match(CONNECT_ALLOW_PATTERN);
    if (match) {
        return {
            timestamp: new Date(),
            method: 'CONNECT',
            host: match[1],
            port: match[2] ? parseInt(match[2], 10) : 443,
            status: 'allowed',
            category: 'http',
            protocol: 'https',
            raw: trimmed,
        };
    }

    // CONNECT blocked (HTTPS tunnel)
    match = trimmed.match(CONNECT_BLOCK_PATTERN);
    if (match) {
        return {
            timestamp: new Date(),
            method: 'CONNECT',
            host: match[1],
            port: match[2] ? parseInt(match[2], 10) : 443,
            status: 'blocked',
            category: 'http',
            protocol: 'https',
            raw: trimmed,
        };
    }

    // Non-HTTP blocked traffic
    match = trimmed.match(NON_HTTP_BLOCK_PATTERN);
    if (match) {
        return {
            timestamp: new Date(),
            host: match[1],
            port: match[2] ? parseInt(match[2], 10) : undefined,
            status: 'blocked',
            category: 'non-http',
            protocol: 'tcp',
            raw: trimmed,
        };
    }

    // DNS resolution
    match = trimmed.match(DNS_PATTERN);
    if (match) {
        return {
            timestamp: new Date(),
            host: match[1],
            status: 'allowed',
            category: 'dns',
            protocol: 'udp',
            raw: trimmed,
        };
    }

    return undefined;
}

/**
 * Parse multiple lines of httpjail output into TrafficEvents.
 * Handles multi-line output by splitting on newlines.
 */
export function parseOutput(output: string): TrafficEvent[] {
    return output
        .split('\n')
        .map(line => parseLogLine(line))
        .filter((event): event is TrafficEvent => event !== undefined);
}

/**
 * Create a line parser that processes a stream buffer.
 * Handles partial lines by buffering until a newline is received.
 */
export function createStreamParser(onEvent: (event: TrafficEvent) => void): {
    push: (chunk: string) => void;
    flush: () => void;
} {
    let buffer = '';

    return {
        push(chunk: string): void {
            buffer += chunk;
            const lines = buffer.split('\n');
            // Keep the last element (possibly incomplete line) in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
                const event = parseLogLine(line);
                if (event) {
                    onEvent(event);
                }
            }
        },
        flush(): void {
            if (buffer.trim()) {
                const event = parseLogLine(buffer);
                if (event) {
                    onEvent(event);
                }
            }
            buffer = '';
        },
    };
}
