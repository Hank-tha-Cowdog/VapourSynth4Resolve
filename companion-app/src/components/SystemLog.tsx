
import React, { useState, useRef, useEffect } from 'react';
import { Terminal, ChevronUp, Minimize2, Maximize2, Minus, Copy, MessageCircle, GripHorizontal } from 'lucide-react';
import { LogEntry } from '../types';
import { Tooltip } from './UI';

interface SystemLogProps {
    logs: LogEntry[];
    expanded: 'CLOSED' | 'NORMAL' | 'MAXIMIZED';
    setExpanded: (state: 'CLOSED' | 'NORMAL' | 'MAXIMIZED') => void;
    onClear: () => void;
    onSendToSage: () => void;
}

export const SystemLog: React.FC<SystemLogProps> = ({ logs, expanded, setExpanded, onClear, onSendToSage }) => {
    const [height, setHeight] = useState(160); // Default height in px
    const [isResizing, setIsResizing] = useState(false);
    const endRef = useRef<HTMLDivElement>(null);

    const toggleTerminal = () => { 
        if(expanded === 'CLOSED') setExpanded('NORMAL'); 
        else if(expanded === 'NORMAL') setExpanded('MAXIMIZED'); 
        else setExpanded('CLOSED'); 
    };

    const handleCopy = () => {
        const text = logs.map(l => `[${l.timestamp}] [${l.type.toUpperCase()}] ${l.message}`).join('\n');
        navigator.clipboard.writeText(text);
    };

    useEffect(() => {
        if (expanded !== 'CLOSED') {
            endRef.current?.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs, expanded]);

    // Resizing Logic
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (isResizing) {
                const newHeight = window.innerHeight - e.clientY;
                setHeight(Math.max(100, Math.min(newHeight, window.innerHeight - 100)));
            }
        };
        const handleMouseUp = () => setIsResizing(false);

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'row-resize';
        } else {
            document.body.style.cursor = 'default';
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
        };
    }, [isResizing]);

    return (
        <div 
            className={`bg-[#0d1117] border-t border-zinc-800 transition-all duration-75 flex flex-col shrink-0 relative`}
            style={{ height: expanded === 'CLOSED' ? '32px' : expanded === 'MAXIMIZED' ? '60vh' : `${height}px` }}
        >
            {/* Resize Handle */}
            {expanded === 'NORMAL' && (
                <div 
                    onMouseDown={() => setIsResizing(true)}
                    className="absolute top-0 left-0 right-0 h-1 cursor-row-resize z-50 hover:bg-purple-500/50 group flex justify-center"
                >
                     {/* Visual Grip Indicator */}
                     <div className="w-16 h-1 rounded-full bg-zinc-700 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
            )}

            <div className="flex items-center justify-between px-4 py-1.5 bg-zinc-900 border-b border-zinc-800 select-none">
                <div className="flex items-center gap-4 cursor-pointer" onClick={toggleTerminal}>
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 tracking-widest font-bold">
                        <Terminal className="w-3.5 h-3.5" /> SYSTEM LOG
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {expanded !== 'CLOSED' && (
                        <>
                            <Tooltip title="Copy Log" content="Copy full log history to clipboard.">
                                <button onClick={handleCopy} className="text-zinc-500 hover:text-white p-1 hover:bg-zinc-800 rounded transition-colors"><Copy className="w-3.5 h-3.5" /></button>
                            </Tooltip>
                            <Tooltip title="Send to Sage" content="Analyze this log with VapourSage AI.">
                                <button onClick={onSendToSage} className="text-zinc-500 hover:text-purple-400 p-1 hover:bg-purple-500/10 rounded transition-colors"><MessageCircle className="w-3.5 h-3.5" /></button>
                            </Tooltip>
                            <div className="w-px h-3 bg-zinc-700 mx-1" />
                            <button onClick={onClear} className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 font-mono uppercase">Purge</button>
                        </>
                    )}
                    <button onClick={toggleTerminal} className="text-zinc-500 hover:text-white p-1">
                        {expanded === 'CLOSED' ? <ChevronUp className="w-3.5 h-3.5" /> : (expanded === 'MAXIMIZED' ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />)}
                    </button>
                    {expanded !== 'CLOSED' && <button onClick={() => setExpanded('CLOSED')} className="text-zinc-500 hover:text-white p-1"><Minus className="w-3.5 h-3.5" /></button>}
                </div>
            </div>
            {expanded !== 'CLOSED' && (
            <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-1 scrollbar-thin scrollbar-thumb-zinc-700">
                {logs.length === 0 && <div className="text-zinc-700 italic">Uplink initialized. Monitoring subsystems...</div>}
                {logs.map((log, i) => (
                    <div key={i} className="flex gap-3 hover:bg-white/5 px-1 rounded">
                        <span className="text-zinc-600 shrink-0 select-none">[{log.timestamp}]</span>
                        <span className={`break-all ${
                            log.type === 'error' ? 'text-red-400' : 
                            log.type === 'success' ? 'text-emerald-400' : 
                            log.type === 'warn' ? 'text-amber-400' : 
                            log.type === 'runtime' ? 'text-blue-400' :
                            'text-zinc-300'
                        }`}>
                            {log.message}
                        </span>
                    </div>
                ))}
                <div ref={endRef} />
            </div>
            )}
        </div>
    );
};
