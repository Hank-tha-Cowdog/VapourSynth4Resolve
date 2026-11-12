// Presentation and polling for the shared plugin/preview report. A chain-ok
// report can be optimistic; it does not establish a live Resolve render.
export type PluginState = 'idle' | 'passthrough' | 'chain-empty' | 'chain-disabled'
    | 'chain-awaiting-approval' | 'config-applied' | 'config-apply-unconfirmed' | 'config-apply-refused'
    | 'chain-ok' | 'chain-error';

export interface PluginReport {
    state: PluginState;
    error: string | null;
    scriptPreview: string;
    stepCount: number;
    timestampMs: number | null;
}

export interface StatusFeed {
    availability: 'loading' | 'ready' | 'unavailable' | 'invalid';
    report: PluginReport | null;
}

export const INITIAL_STATUS_FEED: StatusFeed = { availability: 'loading', report: null };
export const REPORT_STALE_MS = 30_000;
const STATES: readonly string[] = ['idle', 'passthrough', 'chain-empty', 'chain-disabled',
    'chain-awaiting-approval', 'config-applied', 'config-apply-unconfirmed', 'config-apply-refused',
    'chain-ok', 'chain-error'];

export function parsePluginReport(value: unknown): PluginReport | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as Record<string, unknown>;
    if (typeof r.state !== 'string' || !STATES.includes(r.state)
        || (r.error !== null && typeof r.error !== 'string')
        || typeof r.scriptPreview !== 'string'
        || typeof r.stepCount !== 'number' || !Number.isSafeInteger(r.stepCount) || r.stepCount < 0) {
        return null;
    }
    return {
        state: r.state as PluginState, error: r.error as string | null,
        scriptPreview: r.scriptPreview, stepCount: r.stepCount,
        timestampMs: typeof r.timestampMs === 'number' && Number.isSafeInteger(r.timestampMs)
            && r.timestampMs > 0 ? r.timestampMs : null,
    };
}

interface PollTimers {
    schedule: (fn: () => void) => unknown;
    cancel: (handle: unknown) => void;
}

/** Only one read at a time. A late result after disposal must never reach React. */
export function pollPluginStatus(
    read: () => unknown | Promise<unknown>,
    receive: (feed: StatusFeed) => void,
    timers: PollTimers,
): () => void {
    let disposed = false;
    let timer: unknown;
    let lastReport: PluginReport | null = null;
    const tick = async () => {
        try {
            const reply = await read();
            if (disposed) return;
            if (!reply || typeof reply !== 'object' || (reply as { ok?: unknown }).ok !== true) {
                receive({ availability: 'unavailable', report: lastReport });
                return;
            }
            const report = parsePluginReport((reply as { status?: unknown }).status);
            if (!report) {
                receive({ availability: 'invalid', report: lastReport });
                return;
            }
            lastReport = report;
            receive({ availability: 'ready', report });
        } catch {
            if (!disposed) receive({ availability: 'unavailable', report: lastReport });
        } finally {
            if (!disposed) timer = timers.schedule(() => { void tick(); });
        }
    };
    void tick();
    return () => {
        disposed = true;
        if (timer !== undefined) timers.cancel(timer);
    };
}

export function reportAge(timestamp: number | null, now: number): { label: string; stale: boolean; known: boolean } {
    if (timestamp === null || !Number.isFinite(now) || timestamp > now) {
        return { label: 'Update time unavailable', stale: false, known: false };
    }
    const elapsed = Math.max(0, now - timestamp);
    const seconds = Math.floor(elapsed / 1000);
    const label = seconds < 5 ? 'Updated just now'
        : seconds < 60 ? `Updated ${seconds}s ago`
        : seconds < 3600 ? `Updated ${Math.floor(seconds / 60)}m ago`
        : seconds < 86400 ? `Updated ${Math.floor(seconds / 3600)}h ago`
        : `Updated ${Math.floor(seconds / 86400)}d ago`;
    return { label, stale: elapsed >= REPORT_STALE_MS, known: true };
}

export type StatusTone = 'neutral' | 'configured' | 'warning' | 'error';
export interface StatusPresentation {
    title: string;
    message: string;
    tone: StatusTone;
    age: string | null;
    stale: boolean;
}

const TITLES: Record<PluginState, string> = {
    idle: 'Waiting for a report',
    passthrough: 'Passthrough reported',
    'chain-empty': 'No filter steps',
    'chain-disabled': 'Filter steps disabled',
    'chain-awaiting-approval': 'Approval required',
    'config-applied': 'Host apply reported',
    'config-apply-unconfirmed': 'Host apply outcome unconfirmed',
    'config-apply-refused': 'Saved chain refused',
    'chain-ok': 'Chain configured',
    'chain-error': 'Chain error reported',
};

export function statusPresentation(feed: StatusFeed, now: number): StatusPresentation {
    const r = feed.report;
    const age = r ? reportAge(r.timestampMs, now) : null;
    if (feed.availability === 'loading') {
        return { title: 'Checking plugin status…', message: 'Waiting for a status response.',
            tone: 'neutral', age: null, stale: false };
    }
    if (feed.availability !== 'ready' || !r) {
        const previous = r ? ` Last report: ${TITLES[r.state].toLowerCase()}.` : '';
        return {
            title: 'Plugin status unavailable', tone: 'warning', age: age?.label ?? null,
            stale: age?.stale ?? false,
            message: feed.availability === 'invalid'
                ? `An incomplete report was received.${previous} Waiting for a valid update.`
                : r ? `Could not refresh the report.${previous} Updates will retry automatically.`
                    : 'Open the companion from the VapourSynth effect in Resolve to receive status.',
        };
    }
    if (age?.stale) {
        return { title: 'No recent status update', tone: r.state === 'chain-error' || r.state === 'config-apply-unconfirmed' || r.state === 'config-apply-refused' ? 'error' : 'warning',
            message: `Last report: ${TITLES[r.state].toLowerCase()}. Refresh a frame in Resolve for a new report.`,
            age: age.label, stale: true };
    }
    if (age && !age.known) {
        return { title: 'Report time unavailable', tone: 'warning', age: null, stale: false,
            message: `Last report: ${TITLES[r.state].toLowerCase()}. Refresh a frame in Resolve for a new report.` };
    }
    const messages: Record<PluginState, string> = {
        idle: 'Refresh a frame in Resolve after configuring the effect.',
        passthrough: 'No configured chain was reported; output is expected to stay unchanged.',
        'chain-empty': 'Add a filter step to begin configuring the chain.',
        'chain-disabled': 'Enable a step with its eye control, then refresh a frame in Resolve.',
        'chain-awaiting-approval': 'Review and approve a draft step before it can affect the output.',
        'config-apply-unconfirmed': 'The host write may have changed state before returning an error. Inspect the host; no rollback or completed render is established.',
        'config-applied': 'The host action reported accepting a saved configuration. Rendering and project persistence are unconfirmed; later companion edits apply automatically on save and close.',
        'config-apply-refused': 'The host refused the saved chain: it does not evaluate. The previous chain keeps rendering. Fix the chain (check the error and script step code) and save again.',
        'chain-ok': `${r.stepCount} approved filter step${r.stepCount === 1 ? '' : 's'} reported. Refresh a frame in Resolve to verify the output.`,
        'chain-error': 'Output may be passing through unchanged. Open the report to inspect the error.',
    };
    return { title: TITLES[r.state], message: messages[r.state], age: age?.label ?? null, stale: false,
        tone: r.state === 'chain-error' || r.state === 'config-apply-unconfirmed' || r.state === 'config-apply-refused' ? 'error' : r.state === 'chain-ok' ? 'configured'
            : r.state === 'chain-disabled' || r.state === 'chain-awaiting-approval' ? 'warning' : 'neutral' };
}


// ── Resolve plugin installation (vsres-install helper) ────────────────────
// The main process runs the bundled helper; these helpers validate its JSON
// and derive the human-readable line. Parsing is strict: anything without a
// boolean `ok` is rejected so a malformed reply can never render as success.
export type InstallAction = 'status' | 'install' | 'uninstall';

export interface InstallResult {
    ok: boolean;
    error?: string;
    installed?: boolean;
    version?: string | null;
    path?: string;
    resolve_running?: boolean;
    helper_version?: string;
    backup_count?: number;
    action?: string;
    installed_version?: string | null;
    backup?: string | null;
    used_admin?: boolean;
    toml_ok?: boolean;
    toml_output?: string;
    removed?: boolean;
}

export function parseInstallResult(value: unknown): InstallResult | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const r = value as Record<string, unknown>;
    if (typeof r.ok !== 'boolean') return null;
    const out: InstallResult = { ok: r.ok };
    if (typeof r.error === 'string') out.error = r.error;
    if (typeof r.installed === 'boolean') out.installed = r.installed;
    if (r.version === null || typeof r.version === 'string') out.version = r.version as string | null;
    if (typeof r.path === 'string') out.path = r.path;
    if (typeof r.resolve_running === 'boolean') out.resolve_running = r.resolve_running;
    if (typeof r.helper_version === 'string') out.helper_version = r.helper_version;
    if (typeof r.backup_count === 'number') out.backup_count = r.backup_count;
    if (typeof r.action === 'string') out.action = r.action;
    if (r.installed_version === null || typeof r.installed_version === 'string') {
        out.installed_version = r.installed_version as string | null;
    }
    if (r.backup === null || typeof r.backup === 'string') out.backup = r.backup as string | null;
    if (typeof r.used_admin === 'boolean') out.used_admin = r.used_admin;
    if (typeof r.toml_ok === 'boolean') out.toml_ok = r.toml_ok;
    if (typeof r.toml_output === 'string') out.toml_output = r.toml_output;
    if (typeof r.removed === 'boolean') out.removed = r.removed;
    return out;
}

export function installStatusLine(status: InstallResult | null): string {
    if (!status) return 'Installation state unavailable.';
    if (!status.ok) return status.error ? `Installer: ${status.error}` : 'Installer error.';
    const installed = status.installed
        ? `installed${status.version ? ` (v${status.version})` : ''}`
        : 'not installed';
    return `Plugin ${installed}${status.resolve_running ? ' — DaVinci Resolve is running' : ''}.`;
}
