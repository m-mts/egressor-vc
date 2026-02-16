/**
 * Session summary generator - aggregates audit entries into statistics.
 */

import { AuditEntry, SessionSummary } from './types';

const DEFAULT_MAX_TOP_HOSTS = 10;

/**
 * Generate a session summary from audit entries.
 */
export function generateSessionSummary(
    entries: ReadonlyArray<AuditEntry>,
    sessionStart: Date,
    sessionEnd: Date,
    maxTopHosts: number = DEFAULT_MAX_TOP_HOSTS,
): SessionSummary {
    const traffic = {
        total: 0,
        allowed: 0,
        blocked: 0,
        httpAllowed: 0,
        httpBlocked: 0,
        nonHttpBlocked: 0,
        dnsAllowed: 0,
    };

    const secretInjections = {
        total: 0,
        successful: 0,
        failed: 0,
    };

    const hostCounts = new Map<string, number>();
    const anomalies: string[] = [];

    for (const entry of entries) {
        if (entry.type === 'traffic' && entry.trafficEvent) {
            const te = entry.trafficEvent;
            traffic.total++;

            if (te.status === 'allowed') {
                traffic.allowed++;
                if (te.category === 'http') {
                    traffic.httpAllowed++;
                } else if (te.category === 'dns') {
                    traffic.dnsAllowed++;
                }
            } else {
                traffic.blocked++;
                if (te.category === 'http') {
                    traffic.httpBlocked++;
                } else if (te.category === 'non-http') {
                    traffic.nonHttpBlocked++;
                }
            }

            const count = hostCounts.get(te.host) ?? 0;
            hostCounts.set(te.host, count + 1);
        } else if (entry.type === 'secret_injection' && entry.secretInjectionEvent) {
            const se = entry.secretInjectionEvent;
            secretInjections.total++;
            if (se.success) {
                secretInjections.successful++;
            } else {
                secretInjections.failed++;
            }
        }
    }

    // Detect anomalies
    if (traffic.blocked > 0 && traffic.allowed === 0) {
        anomalies.push('All traffic was blocked - check egress rules configuration');
    }
    if (secretInjections.failed > 0) {
        anomalies.push(`${secretInjections.failed} secret injection(s) failed`);
    }
    if (traffic.nonHttpBlocked > 0) {
        anomalies.push(`${traffic.nonHttpBlocked} non-HTTP connection(s) blocked by httpjail strong mode`);
    }

    // Build top hosts
    const topHosts = Array.from(hostCounts.entries())
        .map(([host, count]) => ({ host, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, maxTopHosts);

    return {
        sessionStart: sessionStart.toISOString(),
        sessionEnd: sessionEnd.toISOString(),
        durationMs: sessionEnd.getTime() - sessionStart.getTime(),
        totalEvents: entries.length,
        traffic,
        secretInjections,
        topHosts,
        anomalies,
    };
}

/**
 * Format a session summary as human-readable text for display.
 */
export function formatSessionSummary(summary: SessionSummary): string {
    const lines: string[] = [];

    lines.push('=== Egressor Session Summary ===');
    lines.push('');
    lines.push(`Session: ${summary.sessionStart} to ${summary.sessionEnd}`);
    lines.push(`Duration: ${formatDuration(summary.durationMs)}`);
    lines.push(`Total events: ${summary.totalEvents}`);
    lines.push('');

    lines.push('--- Traffic ---');
    lines.push(`Total requests: ${summary.traffic.total}`);
    lines.push(`  Allowed: ${summary.traffic.allowed} (HTTP: ${summary.traffic.httpAllowed}, DNS: ${summary.traffic.dnsAllowed})`);
    lines.push(`  Blocked: ${summary.traffic.blocked} (HTTP: ${summary.traffic.httpBlocked}, Non-HTTP: ${summary.traffic.nonHttpBlocked})`);
    lines.push('');

    lines.push('--- Secret Injections ---');
    lines.push(`Total: ${summary.secretInjections.total}`);
    lines.push(`  Successful: ${summary.secretInjections.successful}`);
    lines.push(`  Failed: ${summary.secretInjections.failed}`);
    lines.push('');

    if (summary.topHosts.length > 0) {
        lines.push('--- Top Hosts ---');
        for (const { host, count } of summary.topHosts) {
            lines.push(`  ${host}: ${count} request(s)`);
        }
        lines.push('');
    }

    if (summary.anomalies.length > 0) {
        lines.push('--- Anomalies ---');
        for (const anomaly of summary.anomalies) {
            lines.push(`  ! ${anomaly}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
}
