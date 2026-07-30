export function hasResolverFreeze(rule: string, lockAt: Date | null | undefined) {
    return rule === 'oi' || !!lockAt;
}
