// Braille-character spinner. Cycles through 10 Unicode Braille dot patterns to
// produce a smooth rotating-dot effect.
//
// We use a real React hook (not CSS @keyframes) so the spinner works inside
// CodeMirror, popouts, and anywhere the synthwave Loader2 CSS class might not
// resolve. Each character is one of U+280B (⠋) through U+280F (⠏); the sequence
// is the same the npm `cli-spinners` "dots" preset uses, which the synthwave
// audience tends to recognize as the legit terminal spinner.

import React, { useEffect, useState } from 'react';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Props {
    /** Frame interval in ms. 80 is the cli-spinners "dots" default — smooth without being distracting. */
    intervalMs?: number;
    /** Override the font size. Defaults to inheriting from parent. */
    size?: number | string;
    /** Override the color. Defaults to neon-pink synthwave accent. */
    color?: string;
}

export const BrailleSpinner: React.FC<Props> = ({
    intervalMs = 80,
    size,
    color = '#ff44cc',
}) => {
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        const t = setInterval(() => {
            setFrame(f => (f + 1) % FRAMES.length);
        }, intervalMs);
        return () => clearInterval(t);
    }, [intervalMs]);

    return (
        <span
            aria-label="loading"
            style={{
                display: 'inline-block',
                fontFamily: 'JetBrains Mono, Menlo, monospace',
                fontSize: size,
                color,
                fontWeight: 600,
                lineHeight: 1,
                // The braille char column is just over its visual glyph, so we don't
                // need extra width — but a min width keeps the layout from jitter as
                // the frames swap.
                width: '1ch',
                textAlign: 'center',
            }}
        >
            {FRAMES[frame]}
        </span>
    );
};
