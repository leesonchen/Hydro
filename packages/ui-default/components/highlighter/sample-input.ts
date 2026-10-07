function headingNumber(text: string | null | undefined, kind: 'input' | 'output') {
  const heading = text?.trim();
  if (!heading) return null;
  const prefix = kind === 'input' ? /^(?:输入|input|sample\s+input)/i : /^(?:输出|output|sample\s+output)/i;
  const match = heading.match(prefix);
  if (!match) return null;
  let number = heading.slice(match[0].length).trim();
  if (number.startsWith('#')) number = number.slice(1).trimStart();
  return /^\d+$/.test(number) ? number : null;
}

export function getSampleInputCode(env: { element: HTMLElement, code: string }): string | null {
  const match = (env.element.className || '').match(/(?:^|\s)language-input([0-9]+)(?:\s|$)/);
  if (match && Number.isSafeInteger(+match[1])) return env.code;

  const pre = env.element.parentElement;
  const sampleBlock = pre?.parentElement?.classList.contains('code-toolbar') ? pre.parentElement : pre;
  const inputNumber = headingNumber(sampleBlock?.previousElementSibling?.textContent, 'input');
  const outputHeading = sampleBlock?.nextElementSibling;
  const outputNumber = headingNumber(outputHeading?.textContent, 'output');
  const outputBlock = outputHeading?.nextElementSibling;
  const hasOutput = outputBlock?.tagName.toLowerCase() === 'pre'
    || (outputBlock?.classList.contains('code-toolbar') && outputBlock.querySelector('pre'));
  return inputNumber && outputNumber === inputNumber && hasOutput ? env.code : null;
}
