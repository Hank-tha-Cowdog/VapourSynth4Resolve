// QTGMC native-node parameter panel (Phase 2) — the first dedicated filter panel.
//
// Mirrors the params the C++ generator (common/filters/filter_qtgmc.cpp) consumes.
// Only concrete values are stored; anything left "auto" is omitted from params so
// QTGMC's own preset-derived defaults stay in charge. Absent core controls show
// the native defaults without writing them on opening. The probe verdict is a
// hint; it never silently changes the stored field order.

import React, { useId, useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import type { SourceClipMetadata } from '../types';

export interface QTGMCParams {
    label?: string;
    preset?: string;
    tff?: boolean;
    fpsDivisor?: 1 | 2;
    inputType?: 0 | 1 | 2 | 3;
    sharpness?: number;
    tr2?: number;
    sourceMatch?: number;
    lossless?: number;
    thSad2?: number;
    noiseProcess?: 0 | 1 | 2;
    ezDenoise?: number;
    ezKeepGrain?: number;
}

const PRESETS = ['Placebo', 'Very Slow', 'Slower', 'Slow', 'Medium', 'Fast', 'Faster', 'Draft', 'Ultra Fast'];

function hasNoiseControlConflict(params: Record<string, unknown>): boolean {
    return typeof params.ezDenoise === 'number' && params.ezDenoise > 0
        && typeof params.ezKeepGrain === 'number' && params.ezKeepGrain > 0;
}

const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
};
const lbl: React.CSSProperties = {
    fontSize: 11, opacity: 0.75, width: 118, flexShrink: 0,
};
const inp: React.CSSProperties = {
    background: '#150826', border: '1px solid #2a1850', borderRadius: 4,
    color: '#f0e6ff', fontSize: 12, padding: '4px 8px', flex: 1, minWidth: 0,
};
const note: React.CSSProperties = {
    fontSize: 10.5, lineHeight: 1.5, color: '#a78bfa', opacity: 0.85,
    margin: '2px 0 10px 0',
};

type ChoiceValue = string | number | boolean;
type Choice = { value: ChoiceValue; token: string; label: string };
type NumericRule = { integer?: boolean; min?: number; max?: number; guidance: string };
const NUMERIC_RULES: Record<string, NumericRule> = {
    sharpness: { guidance: 'Enter a finite number, or clear for Auto.' },
    tr2: { integer: true, min: -2147483648, max: 2147483647,
        guidance: 'Enter a whole number within the supported range, or clear for Auto.' },
    thSad2: { integer: true, min: 1, max: 2147483647,
        guidance: 'Enter a positive whole number within the supported range, or clear for Auto.' },
    ezDenoise: { min: 0, guidance: 'Enter a finite number of 0 or greater, or clear for Auto.' },
    ezKeepGrain: { min: 0, guidance: 'Enter a finite number of 0 or greater, or clear for Auto.' },
};
function validNumber(value: unknown, rule: NumericRule): value is number {
    return typeof value === 'number' && Number.isFinite(value)
        && (!rule.integer || Number.isInteger(value))
        && (rule.min === undefined || value >= rule.min)
        && (rule.max === undefined || value <= rule.max);
}
function unsupportedChoice(value: unknown, choices: readonly ChoiceValue[]): boolean {
    return value !== undefined && !choices.some(choice => choice === value);
}
function numberChoices(values: readonly number[]): Choice[] {
    return values.map(value => ({ value, token: String(value), label: String(value) }));
}
function hasLosslessConflict(params: Record<string, unknown>): boolean {
    return params.inputType === 1 && (params.lossless === 1 || params.lossless === 2);
}
function conflicts(params: Record<string, unknown>): string[] {
    return [hasNoiseControlConflict(params) ? 'noise' : '', hasLosslessConflict(params) ? 'lossless' : ''].filter(Boolean);
}

export const QTGMCPanel: React.FC<{
    params: Record<string, unknown>;
    clipMetadata?: { source?: SourceClipMetadata | null } | null;
    onChange: (params: Record<string, unknown>) => void;
}> = ({ params, clipMetadata, onChange }) => {
    const p = params as QTGMCParams;
    const panelId = useId();
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);
    const savedNoiseConflict = hasNoiseControlConflict(params);
    const savedLosslessConflict = hasLosslessConflict(params);
    const savedMessages = [
        savedNoiseConflict ? 'Saved settings have positive values for both EZDenoise and EZKeepGrain. Choose one; clear the other or set it to 0.' : '',
        savedLosslessConflict ? 'Saved settings combine positive Lossless with Input type 1. Choose Lossless 0 or Auto, or change Input type.' : '',
    ].filter(Boolean);
    const feedback = [...savedMessages, editError].filter(Boolean).join(' ') || null;
    const feedbackId = feedback ? `${panelId}-setting-error` : undefined;

    const set = (patch: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...params };
        // Auto clears only the explicitly edited key. Unknown extension settings
        // (including their own empty/undefined values) are not ours to normalize.
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete next[key];
            else next[key] = value;
        }
        const before = conflicts(params), after = conflicts(next);
        // Permit an explicit repair of one saved conflict while another remains;
        // otherwise two independent saved conflicts would have no repair path.
        if (after.length && (after.some(kind => !before.includes(kind)) || after.length >= before.length)) {
            setEditError(after.includes('noise')
                ? 'Change not applied. Use a positive value for either EZDenoise or EZKeepGrain; clear the other or set it to 0.'
                : 'Change not applied. Positive Lossless cannot be combined with Input type 1. Choose Lossless 0 or Auto, or change Input type.');
            return;
        }
        setEditError(null);
        onChange(next);
    };
    const rejectNumber = (message: string) => setEditError(`Change not applied. ${message}`);
    const advancedProblems = [
        ...Object.entries(NUMERIC_RULES).filter(([key, rule]) => params[key] !== undefined && !validNumber(params[key], rule)).map(([key]) => key),
        ...(['sourceMatch', 'lossless', 'noiseProcess'] as const).filter(key => unsupportedChoice(params[key], key === 'sourceMatch' ? [0, 1, 2, 3] : [0, 1, 2])),
    ];
    const labelUnsupported = p.label !== undefined && typeof p.label !== 'string';
    const tffUnsupported = unsupportedChoice(p.tff, [true, false]);
    const detected = (clipMetadata?.source as { video?: { detectedScanType?: string } } | null | undefined)?.video?.detectedScanType;
    const verdictHint = detected === 'tt' ? 'probe verdict: TFF (pixel content)'
                      : detected === 'bb' ? 'probe verdict: BFF (pixel content)' : null;

    return (
        <div style={{ fontSize: 12 }}>
            <div style={row}>
                <label style={lbl} htmlFor={`${panelId}-label`}>Label</label>
                <input id={`${panelId}-label`} style={inp}
                    value={typeof p.label === 'string' ? p.label : ''}
                    placeholder={labelUnsupported ? 'Unrecognized saved value' : 'QTGMC — Archival Deinterlace'}
                    aria-invalid={labelUnsupported || undefined}
                    aria-describedby={labelUnsupported ? `${panelId}-label-error` : undefined}
                    onChange={e => set({ label: e.target.value === '' ? undefined : e.target.value })} />
                {labelUnsupported && <button id={`${panelId}-label-clear`} type="button"
                    aria-label="Clear label" onClick={() => set({ label: undefined })}
                    style={{ ...inp, flex: 'none', cursor: 'pointer' }}>Clear label</button>}
            </div>
            {labelUnsupported && <p id={`${panelId}-label-error`} role="alert" style={{ ...note, color: '#ff5577' }}>
                Label has an unrecognized saved value. Enter a label or use Clear label.
            </p>}
            <ChoiceRow label="Preset" value={p.preset} defaultValue="Slower"
                choices={PRESETS.map(value => ({ value, token: value, label: value }))}
                onChange={value => set({ preset: value })} />
            <p style={note}>Speed and quality preset. Slower is this plugin's default; faster presets can help while iterating.</p>
            <ChoiceRow label="Field order" value={p.tff} defaultValue={true}
                choices={[{ value: true, token: 'tff', label: 'TFF — top field first' }, { value: false, token: 'bff', label: 'BFF — bottom field first' }]}
                disabled={p.inputType === 1 && !tffUnsupported}
                onChange={value => set({ tff: value })} />
            {verdictHint && <p style={{ ...note, color: '#2bffd6' }}>
                <Info size={10} style={{ verticalAlign: '-1px' }} /> {verdictHint} — container flags can be unreliable; check the pixel scan.
            </p>}
            <ChoiceRow label="Output rate" value={p.fpsDivisor} defaultValue={2}
                choices={[{ value: 2, token: '2', label: 'Single-rate — one frame per source frame (no bob)' },
                    { value: 1, token: '1', label: 'Double-rate — 2× fps (srestore / 50p·59.94p workflows)' }]}
                onChange={value => set({ fpsDivisor: value })} />
            <p style={note}>Single-rate keeps the source frame count (25i → 25p). Double-rate is the intermediate
                used when an srestore step follows to recover a blended standards conversion.</p>
            <ChoiceRow label="Input type" value={p.inputType} defaultValue={0}
                choices={[{ value: 0, token: '0', label: '0 — interlaced source (normal)' },
                    { value: 1, token: '1', label: '1 — progressive w/ combing (repair)' },
                    { value: 2, token: '2', label: '2 — progressive deshimmer A' },
                    { value: 3, token: '3', label: '3 — progressive deshimmer B' }]}
                invalid={savedLosslessConflict} errorId={savedLosslessConflict ? feedbackId : undefined}
                onChange={value => set({ inputType: value })} />
            {feedback && <p id={feedbackId} role="alert" aria-label="QTGMC setting feedback" style={{ ...note, color: '#ff5577' }}>{feedback}</p>}
            {advancedProblems.length > 0 && <p id={`${panelId}-advanced-notice`} role="status" style={{ ...note, color: '#ffcc66' }}>
                Advanced settings contain unrecognized saved values. Open Advanced to review and explicitly repair them.
            </p>}
            <button type="button" aria-expanded={showAdvanced} aria-controls={`${panelId}-advanced`}
                aria-describedby={advancedProblems.length ? `${panelId}-advanced-notice` : undefined}
                onClick={() => setShowAdvanced(value => !value)}
                style={{ background: 'none', border: 'none', color: '#ff2bd6', cursor: 'pointer', fontSize: 11,
                    padding: '2px 0 8px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                {showAdvanced ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                Advanced (Auto = QTGMC preset default)
            </button>
            <div id={`${panelId}-advanced`} hidden={!showAdvanced} style={{ paddingLeft: 4 }}>
                <ChoiceRow label="Noise processing" value={p.noiseProcess} allowAuto
                    choices={[{ value: 0, token: '0', label: '0 — off' }, { value: 1, token: '1', label: '1 — denoise input' },
                        { value: 2, token: '2', label: '2 — temporal noise processing' }]}
                    hint="Auto omits NoiseProcess so QTGMC chooses its default. Zero explicitly disables this noise-processing path; other smoothing settings still apply."
                    onChange={value => set({ noiseProcess: value })} />
                <NumRow label="Sharpness" value={p.sharpness} step={0.1} rule={NUMERIC_RULES.sharpness}
                    hint="Resharpening after temporal smoothing. Values at or below 0 disable this sharpening mode."
                    errorId={feedbackId} onInvalid={rejectNumber} onChange={value => set({ sharpness: value })} />
                <NumRow label="TR2" value={p.tr2} step={1} rule={NUMERIC_RULES.tr2}
                    hint="Final temporal smoothing radius; 0–3 is typical. In the current QTGMC library, an explicit TR2 override is used with SourceMatch 1–3. At SourceMatch Auto/0, the preset radius is used."
                    errorId={feedbackId} onInvalid={rejectNumber} onChange={value => set({ tr2: value })} />
                <ChoiceRow label="SourceMatch" value={p.sourceMatch} allowAuto choices={numberChoices([0, 1, 2, 3])}
                    hint="Auto and 0 use QTGMC's default SourceMatch 0. Values 1–3 refine the output against the source fields, independently of Lossless."
                    onChange={value => set({ sourceMatch: value })} />
                <ChoiceRow label="Lossless" value={p.lossless} allowAuto choices={numberChoices([0, 1, 2])}
                    hint="0 leaves the processed result. Values 1–2 restore original field lines and are incompatible with Input type 1. Check the trade on your own material."
                    invalid={savedLosslessConflict} errorId={savedLosslessConflict ? feedbackId : undefined}
                    onChange={value => set({ lossless: value })} />
                <NumRow label="ThSAD2" value={p.thSad2} step={16} rule={NUMERIC_RULES.thSad2}
                    hint="Positive whole-number matching threshold for final temporal smoothing. Compare grain and detail on your own material before choosing a value."
                    errorId={feedbackId} onInvalid={rejectNumber} onChange={value => set({ thSad2: value })} />
                <NumRow label="EZDenoise" value={p.ezDenoise} step={0.5} rule={NUMERIC_RULES.ezDenoise}
                    hint="Quick noise reduction strength. Mutually exclusive with positive EZKeepGrain. Zero leaves this optional argument off."
                    invalid={savedNoiseConflict} errorId={feedbackId} onInvalid={rejectNumber} onChange={value => set({ ezDenoise: value })} />
                <NumRow label="EZKeepGrain" value={p.ezKeepGrain} step={0.5} rule={NUMERIC_RULES.ezKeepGrain}
                    hint="Simplified grain-retention control. Mutually exclusive with positive EZDenoise. Zero leaves this optional argument off."
                    invalid={savedNoiseConflict} errorId={feedbackId} onInvalid={rejectNumber} onChange={value => set({ ezKeepGrain: value })} />
            </div>
        </div>
    );
};

const ChoiceRow: React.FC<{
    label: string; value: unknown; choices: readonly Choice[]; defaultValue?: ChoiceValue;
    allowAuto?: boolean; hint?: string; disabled?: boolean; invalid?: boolean; errorId?: string;
    onChange: (value: ChoiceValue | undefined) => void;
}> = ({ label, value, choices, defaultValue, allowAuto, hint, disabled, invalid, errorId, onChange }) => {
    const inputId = useId();
    const saved = choices.find(choice => choice.value === value);
    const missing = value === undefined;
    const unsupported = !missing && !saved;
    const fallback = choices.find(choice => choice.value === defaultValue);
    const selected = missing ? allowAuto ? '' : fallback?.token : saved?.token;
    const description = [hint ? `${inputId}-hint` : '', unsupported ? `${inputId}-error` : '', errorId || ''].filter(Boolean).join(' ');
    return <div style={{ marginBottom: 8 }}>
        <div style={row}>
            <label style={lbl} htmlFor={inputId}>{label}</label>
            <select id={inputId} style={inp} value={unsupported ? 'unsupported' : selected}
                aria-describedby={description || undefined} aria-invalid={unsupported || invalid || undefined} disabled={disabled}
                onChange={event => {
                    if (disabled) return;
                    const token = event.target.value;
                    if (allowAuto && token === '') { onChange(undefined); return; }
                    const choice = choices.find(item => item.token === token);
                    if (choice) onChange(choice.value);
                }}>
                {allowAuto && <option value="">Auto (QTGMC default)</option>}
                {unsupported && <option value="unsupported" disabled>Unrecognized saved value</option>}
                {choices.map(choice => <option key={choice.token} value={choice.token}>{choice.label}</option>)}
            </select>
        </div>
        {hint && <p id={`${inputId}-hint`} style={{ ...note, margin: '0 0 6px 0' }}>{hint}</p>}
        {unsupported && <p id={`${inputId}-error`} role="alert" style={{ ...note, color: '#ff5577' }}>
            {label} has an unrecognized saved value. Choose {allowAuto ? 'Auto or ' : ''}a listed value.
        </p>}
    </div>;
};

const NumRow: React.FC<{
    label: string; value: unknown; step: number; rule: NumericRule; hint: string;
    errorId?: string; invalid?: boolean;
    onInvalid: (message: string) => void; onChange: (value: number | undefined) => void;
}> = ({ label, value, step, rule, hint, errorId, invalid, onInvalid, onChange }) => {
    const inputId = useId();
    const supported = validNumber(value, rule), unsupported = value !== undefined && !supported;
    const description = [`${inputId}-hint`, unsupported ? `${inputId}-error` : '', errorId || ''].filter(Boolean).join(' ');
    return <div style={{ marginBottom: 8 }}>
        <div style={row}>
            <label style={lbl} htmlFor={inputId}>{label}</label>
            <input id={inputId} style={inp} type="number" step={step} min={rule.min} max={rule.max}
                aria-describedby={description} aria-invalid={unsupported || invalid || undefined}
                value={supported ? value : ''} placeholder={unsupported ? 'Unrecognized saved value' : 'auto'}
                onChange={event => {
                    const raw = event.target.value;
                    if (event.target.validity?.badInput) { onInvalid(`${label}: ${rule.guidance}`); return; }
                    if (raw === '') { onChange(undefined); return; }
                    // Accept a complete decimal/exponent token, never a numeric prefix.
                    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
                        onInvalid(`${label}: ${rule.guidance}`); return;
                    }
                    const number = Number(raw);
                    if (!validNumber(number, rule)) { onInvalid(`${label}: ${rule.guidance}`); return; }
                    onChange(number);
                }} />
            {unsupported && <button type="button" aria-label={`Use Auto for ${label}`}
                onClick={() => onChange(undefined)} style={{ ...inp, flex: 'none', cursor: 'pointer' }}>Use Auto</button>}
        </div>
        <p id={`${inputId}-hint`} style={{ ...note, margin: '0 0 6px 0' }}>{hint}</p>
        {unsupported && <p id={`${inputId}-error`} role="alert" style={{ ...note, color: '#ff5577' }}>
            {label} has an unrecognized saved value. {rule.guidance}
        </p>}
    </div>;
};
