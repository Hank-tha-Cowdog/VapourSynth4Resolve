// UI disclosure state only; no chain mutation, approval, bridge or processing.
export function reconcileChainExpansion(
    expanded: Set<string>, knownIds: ReadonlySet<string>, currentIds: readonly string[],
): Set<string> {
    const next = new Set(currentIds.filter(id => expanded.has(id) || !knownIds.has(id)));
    // Preserve the existing state object when only parameters or ordering changed.
    return next.size === expanded.size && [...next].every(id => expanded.has(id))
        ? expanded : next;
}
