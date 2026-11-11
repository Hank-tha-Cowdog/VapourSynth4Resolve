// Tab bar for the center column of the popout.
// Inspired by vapoursage's `activeView` pattern in App.tsx — one main content area
// switches between Chain editing, Preview, and Logs.

import React from 'react';
import { Layers, PlayCircle, Terminal, Workflow, FileCode2, Package, type LucideIcon } from 'lucide-react';

export type CenterTab = 'chain' | 'pipeline' | 'preview' | 'script' | 'models' | 'logs';

interface Props {
    active: CenterTab;
    onChange: (tab: CenterTab) => void;
    /** Optional right-aligned content (e.g. per-tab toolbars). */
    rightSlot?: React.ReactNode;
}

const TABS: { id: CenterTab; label: string; icon: LucideIcon }[] = [
    { id: 'chain',    label: 'Chain',    icon: Layers },
    { id: 'pipeline', label: 'Pipeline', icon: Workflow },
    { id: 'preview',  label: 'Preview',  icon: PlayCircle },
    { id: 'script',   label: 'Script',   icon: FileCode2 },
    { id: 'models',   label: 'Models',   icon: Package },
    { id: 'logs',     label: 'Logs',     icon: Terminal },
];

export const CenterTabs: React.FC<Props> = ({ active, onChange, rightSlot }) => (
    <div style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        borderBottom: '1px solid #2a1850',
        background: '#0d0418',
        flexShrink: 0,
    }}>
        <div role="group" aria-label="Workspace view" style={{ display: 'flex', flexWrap: 'wrap' }}>
        {TABS.map(t => {
            const isActive = t.id === active;
            return (
                <button
                    key={t.id}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => onChange(t.id)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 7,
                        padding: '9px 16px',
                        minHeight: 44,
                        background: 'transparent', border: 'none',
                        borderBottom: isActive ? '2px solid #ff2bd6' : '2px solid transparent',
                        color: isActive ? '#ff2bd6' : '#999',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: isActive ? 600 : 400,
                        letterSpacing: 0.3,
                        transition: 'color 0.1s, border-color 0.1s',
                        textShadow: isActive ? '0 0 8px rgba(255, 43, 214, 0.4)' : 'none',
                    }}
                >
                    <t.icon size={13} aria-hidden="true" />
                    {t.label}
                </button>
            );
        })}
        </div>
        {rightSlot && (
            <>
                <div style={{ flex: 1 }} />
                <div style={{ paddingRight: 14, display: 'flex', alignItems: 'center' }}>
                    {rightSlot}
                </div>
            </>
        )}
    </div>
);
