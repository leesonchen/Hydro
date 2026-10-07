export function canUsePretest(
  config?: { type?: string } | null,
  langInfo?: { pretest?: boolean | string, validAs?: unknown, hidden?: boolean } | null,
): boolean {
  let canPretest = config?.type === 'default';
  if (config?.type === 'remote_judge' && langInfo) {
    if (langInfo.pretest) canPretest = true;
    if (langInfo.validAs && !langInfo.hidden) canPretest = true;
  }
  if (langInfo?.pretest === false) canPretest = false;
  return canPretest;
}
