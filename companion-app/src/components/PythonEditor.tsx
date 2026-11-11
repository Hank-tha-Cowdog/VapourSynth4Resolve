// CodeMirror 6 Python editor with a synthwave theme.
// Flex-fills its parent container — no fixed heights. Drop me inside a flex column
// with `flex:1; min-height:0` and I take exactly that space.

import React, { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Synthwave palette tuned for readability on a near-black background.
//   pink/magenta  → keywords, operators
//   cyan          → function names, classes
//   orange-pink   → numbers, constants
//   lime          → strings
//   muted purple  → comments (clearly de-emphasized but still readable, since the
//                   Archivist writes a lot of teaching comments and we want them
//                   scannable, not invisible)
const SYNTHWAVE_HIGHLIGHT = HighlightStyle.define([
    { tag: t.keyword,                       color: '#ff2bd6', fontWeight: '600' },
    { tag: [t.operator, t.operatorKeyword], color: '#ff2bd6' },
    { tag: t.controlKeyword,                color: '#ff2bd6', fontStyle: 'italic' },
    { tag: [t.string, t.special(t.string)], color: '#a3ff8a' },
    { tag: t.regexp,                        color: '#a3ff8a' },
    { tag: [t.number, t.bool, t.null],      color: '#ffb085' },
    { tag: t.literal,                       color: '#ffb085' },
    { tag: t.comment,                       color: '#8e7cb8', fontStyle: 'italic' },
    { tag: t.lineComment,                   color: '#8e7cb8', fontStyle: 'italic' },
    { tag: t.docComment,                    color: '#b6a0e0', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#5cf7ff' },
    { tag: t.className,                     color: '#5cf7ff' },
    { tag: t.definition(t.variableName),    color: '#f0e6ff' },
    { tag: t.propertyName,                  color: '#e9c6ff' },
    { tag: t.typeName,                      color: '#5cf7ff' },
    { tag: t.tagName,                       color: '#ff2bd6' },
    { tag: t.variableName,                  color: '#f0e6ff' },
    { tag: t.invalid,                       color: '#ff5577' },
]);

// EditorView theme. `&` height 100% lets CodeMirror fill the React wrapper, which
// itself is a flex:1 minHeight:0 child — chains the height all the way down.
const SYNTHWAVE_THEME = EditorView.theme({
    '&': {
        backgroundColor: '#0a0414',
        color: '#f0e6ff',
        fontSize: '12px',
        height: '100%',
    },
    '.cm-content': {
        caretColor: '#ff2bd6',
        fontFamily: '"JetBrains Mono", Menlo, monospace',
    },
    '.cm-gutters': {
        backgroundColor: '#100722',
        color: '#5a4a78',
        border: 'none',
        borderRight: '1px solid #2a1850',
    },
    '.cm-activeLine': {
        backgroundColor: 'rgba(255, 43, 214, 0.06)',
    },
    '.cm-activeLineGutter': {
        backgroundColor: 'rgba(255, 43, 214, 0.10)',
        color: '#ff2bd6',
    },
    '.cm-cursor': {
        borderLeftColor: '#ff2bd6',
        borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, ::selection': {
        backgroundColor: 'rgba(255, 43, 214, 0.25) !important',
    },
    '&.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(255, 43, 214, 0.3) !important',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'rgba(255, 43, 214, 0.18)',
        outline: '1px solid rgba(255, 43, 214, 0.6)',
    },
    '.cm-tooltip': {
        background: '#1a0830',
        border: '1px solid #2a1850',
        color: '#f0e6ff',
    },
    '.cm-searchMatch': {
        backgroundColor: 'rgba(92, 247, 255, 0.18)',
        outline: '1px solid #5cf7ff',
    },
    '.cm-scroller': {
        fontFamily: '"JetBrains Mono", Menlo, monospace',
        lineHeight: '1.55',
        overflow: 'auto',
    },
    '.cm-editor': {
        height: '100%',
    },
}, { dark: true });

interface Props {
    value: string;
    onChange: (next: string) => void;
    readOnly?: boolean;
}

export const PythonEditor: React.FC<Props> = ({ value, onChange, readOnly = false }) => {
    const extensions = useMemo(() => [
        python(),
        syntaxHighlighting(SYNTHWAVE_HIGHLIGHT),
        SYNTHWAVE_THEME,
        EditorView.lineWrapping,
    ], []);

    return (
        <div style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid #2a1850',
            borderRadius: 4,
            overflow: 'hidden',
            background: '#0a0414',
        }}>
            <CodeMirror
                value={value}
                onChange={onChange}
                extensions={extensions}
                theme="dark"
                basicSetup={{
                    lineNumbers: true,
                    highlightActiveLine: true,
                    highlightActiveLineGutter: true,
                    foldGutter: true,
                    bracketMatching: true,
                    closeBrackets: true,
                    autocompletion: true,
                    indentOnInput: true,
                    syntaxHighlighting: true,
                    tabSize: 4,
                }}
                readOnly={readOnly}
                height="100%"
                style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
            />
        </div>
    );
};
