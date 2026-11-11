


import { LogEntry } from "../types";

// --- RUNTIME BRIDGE SERVICE ---
// This service automatically switches between the Real Electron Backend
// and the Browser Simulation based on environment detection.

export const executeVapourSynthScript = async (
    script: string, 
    onLog: (log: LogEntry) => void,
    onComplete: (code: number, error?: string) => void
) => {
    // 1. CHECK FOR ELECTRON
    if (window.electron) {
        // --- REAL MODE ---
        // We are running in the downloaded Electron App.
        
        // Setup Listeners & Capture Cleanup Functions
        const cleanupLog = window.electron.onLog((log) => {
            const entry = { 
                ...log, 
                timestamp: log.timestamp || new Date().toLocaleTimeString() 
            };
            onLog(entry);
        });

        const cleanupComplete = window.electron.onComplete((result) => {
            if (result.code === 0) {
                onLog({ timestamp: new Date().toLocaleTimeString(), type: 'success', message: 'Processing Cycle Completed Successfully.' });
            } else {
                onLog({ timestamp: new Date().toLocaleTimeString(), type: 'error', message: `Processing Failed with Exit Code ${result.code}` });
            }
            
            // Detach listeners once complete to prevent duplicate logs on next run
            cleanupLog();
            cleanupComplete();

            onComplete(result.code, result.error);
        });

        // Fire the command
        onLog({ timestamp: new Date().toLocaleTimeString(), type: 'info', message: 'Handing off payload to Main Process...' });
        window.electron.executeScript(script);

    } else {
        // --- SIMULATION MODE ---
        // We are running in the Browser Preview.
        executeMockScript(script, onLog, onComplete);
    }
};


// --- MOCK SIMULATION LOGIC (For Browser Preview) ---
const executeMockScript = async (
    script: string, 
    onLog: (log: LogEntry) => void,
    onComplete: (code: number, error?: string) => void
) => {
    const MOCK_DELAY_MS = 800;
    
    onLog({ timestamp: new Date().toLocaleTimeString(), type: 'info', message: '--- BROWSER PREVIEW MODE ---' });
    onLog({ timestamp: new Date().toLocaleTimeString(), type: 'warn', message: 'Simulating VapourSynth Runtime (Actual execution requires Electron)' });
    
    await new Promise(r => setTimeout(r, 200));
    
    // Detect if the script has intentional errors (for testing "Repair" feature)
    const hasIntentionalError = script.includes("# FAIL");

    const RUNTIME_CONFIG = {
        python: "/Resources/runtime/python/bin/python3",
        ffmpeg: "/Resources/runtime/bin/ffmpeg",
        vs_core: "/Resources/runtime/lib/vapoursynth.dylib",
        plugins: "/Resources/runtime/lib/plugins"
    };

    onLog({ timestamp: new Date().toLocaleTimeString(), type: 'runtime', message: `DETECTED_OS: darwin (macOS) - arm64 (SIMULATED)` });
    onLog({ timestamp: new Date().toLocaleTimeString(), type: 'runtime', message: `PYTHON_PATH: ${RUNTIME_CONFIG.python}` });

    await new Promise(r => setTimeout(r, 300));

    const ENV_VARS = {
        "PYTHONPATH": "bundled/site-packages",
        "VS_PLUGIN_PATH": RUNTIME_CONFIG.plugins
    };

    onLog({ timestamp: new Date().toLocaleTimeString(), type: 'runtime', message: `ENV_INJECTION: VS_PLUGIN_PATH -> ${RUNTIME_CONFIG.plugins}` });

    await new Promise(r => setTimeout(r, MOCK_DELAY_MS));

    onLog({ timestamp: new Date().toLocaleTimeString(), type: 'info', message: `SPAWNING PROCESS: ${RUNTIME_CONFIG.python} | ${RUNTIME_CONFIG.ffmpeg}` });

    // Simulate Crash
    if (hasIntentionalError) {
        await new Promise(r => setTimeout(r, 500));
        onLog({ timestamp: new Date().toLocaleTimeString(), type: 'error', message: 'Traceback (most recent call last):' });
        onLog({ timestamp: new Date().toLocaleTimeString(), type: 'error', message: '  File "<string>", line 4, in <module>' });
        onLog({ timestamp: new Date().toLocaleTimeString(), type: 'error', message: 'vapoursynth.Error: Filter not found: QTGMC (Did you load the plugin?)' });
        onComplete(1, "vapoursynth.Error: Filter not found: QTGMC (Did you load the plugin?)");
        return;
    }

    const mockLogs = [
        "VapourSynth Video Processing Framework 65",
        "Core: R65",
        "API: 4.0",
        "Loading plugin: libmvtools.dylib [OK]",
        "Loading plugin: libffms2.dylib [OK]",
        "Resolution: 720x480 -> 720x480",
        "Format: YUV420P8",
        "Output: 24000/1001 fps",
        "--- PIPELINE ESTABLISHED ---",
    ];

    for (const log of mockLogs) {
        await new Promise(r => setTimeout(r, 150));
        onLog({ timestamp: new Date().toLocaleTimeString(), type: 'runtime', message: log });
    }

    onLog({ timestamp: new Date().toLocaleTimeString(), type: 'info', message: `FFMPEG: Pipe connected. Encoding started.` });
    
    let frame = 0;
    const interval = setInterval(() => {
        frame += 48; 
        if (frame >= 500) { 
            clearInterval(interval);
            onLog({ timestamp: new Date().toLocaleTimeString(), type: 'success', message: `BATCH COMPLETE: Output written to /Export/` });
            onComplete(0);
        } else {
            const fps = 42.5;
            const size = (frame * 0.05).toFixed(2);
            // Matches 'Frame: ' format for VapourSynth consistency
            onLog({ timestamp: new Date().toLocaleTimeString(), type: 'info', message: `Frame: ${frame} fps=${fps} size=${size}MB time=00:00:${(frame/24).toFixed(2)} bitrate=1250kbits/s speed=1.8x` });
        }
    }, 100);
};