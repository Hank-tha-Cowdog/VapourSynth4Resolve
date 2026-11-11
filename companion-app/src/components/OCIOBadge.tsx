// Capability badge. The legacy component name does not imply OCIO is integrated.
// common/color/color.cpp currently emits mvsfunc matrix conversions only.

import React from 'react';

interface Props {
    /** Pixel size of the color-wheel mark. Default 14. */
    size?: number;
    /** Show the matrix-only label. The accessible limitation remains in compact mode. */
    showLabel?: boolean;
    /** Pass-through style for the wrapping <span>. */
    style?: React.CSSProperties;
}

const TOOLTIP =
    'Limited color conversion: OCIO is not integrated in the current composer. ' +
    'RGB/YUV conversions use mvsfunc matrices. Unsupported color-space names ' +
    'fall back to the Rec.709 matrix. Gamma selections are stored labels; ' +
    'they do not apply a transfer-function transform. Individual filters may change pixels.';

export const OCIOBadge: React.FC<Props> = ({ size = 14, showLabel = true, style }) => (
    <span
        role="note"
        aria-label="Limited color conversion: OCIO is not integrated"
        title={TOOLTIP}
        style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            background: 'linear-gradient(90deg, rgba(255, 68, 204, 0.10) 0%, rgba(196, 168, 255, 0.10) 50%, rgba(91, 200, 255, 0.10) 100%)',
            border: '1px solid rgba(196, 168, 255, 0.35)',
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: '#c4a8ff',
            lineHeight: 1,
            verticalAlign: 'middle',
            cursor: 'help',
            ...style,
        }}
    >
        <OCIOMark size={size} />
        {showLabel && <span>Matrix only</span>}
    </span>
);

// Inline SVG color-wheel — 6 segments evoking the OCIO color-management
// concept without copying the exact OCIO logo (which carries the ASWF
// trademark). The wedges go red → orange → yellow → green → cyan → blue →
// magenta, similar to a hue wheel. Center is hollow so the mark reads as a
// ring at small sizes.
const OCIOMark: React.FC<{ size: number }> = ({ size }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{ flexShrink: 0, display: 'block' }}
        aria-hidden="true"
    >
        <defs>
            <linearGradient id="ocio-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%"   stopColor="#ff44cc" />
                <stop offset="20%"  stopColor="#ff8844" />
                <stop offset="40%"  stopColor="#ffee44" />
                <stop offset="60%"  stopColor="#44ff99" />
                <stop offset="80%"  stopColor="#5ec8ff" />
                <stop offset="100%" stopColor="#8a2be2" />
            </linearGradient>
        </defs>
        {/* Outer ring with rainbow gradient */}
        <circle
            cx="12" cy="12" r="9"
            fill="none"
            stroke="url(#ocio-grad)"
            strokeWidth="3"
            strokeLinecap="round"
        />
        {/* Small inner dot for visual anchor */}
        <circle cx="12" cy="12" r="2" fill="#c4a8ff" opacity="0.7" />
    </svg>
);
