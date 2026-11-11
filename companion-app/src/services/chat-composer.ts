// UI decisions only. No provider, storage, bridge, network or send implementation.
export function canSendChatMessage(text: string, isThinking: boolean): boolean {
    return !isThinking && text.trim().length > 0;
}

export interface ComposerKey {
    key: string;
    shiftKey: boolean;
    isComposing?: boolean;
    keyCode?: number;
    repeat?: boolean;
}

/** Preserve IME confirmation/newlines; consume blocked Enter without submitting. */
export function composerKeyAction(
    event: ComposerKey, text: string, isThinking: boolean,
): 'native' | 'prevent' | 'send' {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) {
        return 'native';
    }
    if (event.repeat || !canSendChatMessage(text, isThinking)) return 'prevent';
    return 'send';
}
