// DOM focus only. No settings data, storage, Electron bridge or provider access.
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

function focusTargets(dialog: HTMLElement): HTMLElement[] {
    return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element =>
        element.tabIndex >= 0 && !element.matches(':disabled')
        && !element.closest('[hidden], [inert], [aria-hidden="true"]')
        && element.getClientRects().length > 0);
}

function focusStart(dialog: HTMLElement): void {
    const targets = focusTargets(dialog);
    const preferred = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]');
    (preferred && targets.includes(preferred) ? preferred : targets[0] ?? dialog)
        .focus({ preventScroll: true });
}

/** Install focus containment and return an idempotent cleanup that restores the opener. */
export function mountSettingsDialogFocus(dialog: HTMLElement): () => void {
    const document = dialog.ownerDocument;
    const opener = document.activeElement as HTMLElement | null;
    let disposed = false;
    const containFocus = (event: FocusEvent) => {
        if (!dialog.contains(event.target as Node | null)) focusStart(dialog);
    };
    focusStart(dialog);
    document.addEventListener('focusin', containFocus);
    return () => {
        if (disposed) return;
        disposed = true;
        document.removeEventListener('focusin', containFocus);
        // Do not steal focus from another dialog opened during unmount.
        if (opener?.isConnected && typeof opener.focus === 'function'
            && (dialog.contains(document.activeElement) || document.activeElement === document.body)) {
            opener.focus({ preventScroll: true });
        }
    };
}

export interface SettingsDialogKey {
    key: string;
    shiftKey: boolean;
    defaultPrevented: boolean;
    isComposing?: boolean;
    keyCode?: number;
    preventDefault: () => void;
    stopPropagation: () => void;
}

export function handleSettingsDialogKey(
    event: SettingsDialogKey, dialog: HTMLElement, onClose: () => void,
): void {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
    }
    if (event.key !== 'Tab') return;
    const targets = focusTargets(dialog);
    const index = targets.indexOf(dialog.ownerDocument.activeElement as HTMLElement);
    if (!targets.length || index < 0
        || (event.shiftKey ? index === 0 : index === targets.length - 1)) {
        event.preventDefault();
        const next = event.shiftKey ? targets[targets.length - 1] : targets[0];
        (next ?? dialog).focus({ preventScroll: true });
    }
}
