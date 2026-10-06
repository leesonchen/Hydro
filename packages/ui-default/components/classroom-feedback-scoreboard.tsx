import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import ClassroomFeedback from './classroom-feedback';

// One root per scoreboard, with a plain-link fallback before JS is ready.
export function bindFeedbackScoreboard() {
  let selected: { uid: string, pid: string, href: string } | null = null;
  let row: HTMLTableRowElement | null = null;
  let root: Root | null = null;
  const sync = () => {
    if (!selected) return;
    if (row && !row.isConnected) {
      root?.unmount();
      root = null;
      row = null;
    }
    const entry = [...document.querySelectorAll<HTMLAnchorElement>('.cf-scoreboard-entry')].find(
      (item) => item.dataset.feedbackUid === selected.uid && item.dataset.feedbackPid === selected.pid,
    );
    const main = entry?.closest('tr');
    const tableBody = document.querySelector('[data-fragment-id="scoreboard"] tbody');
    if (!main && !tableBody) return;
    if (!row) {
      row = document.createElement('tr');
      row.className = 'cf-scoreboard-editor';
      const cell = document.createElement('td');
      cell.colSpan = main?.children.length || document.querySelector('[data-fragment-id="scoreboard"] thead tr')!.children.length;
      const container = document.createElement('div');
      cell.append(container);
      row.append(cell);
      root = createRoot(container);
    }
    if (main) main.after(row);
    else tableBody!.append(row);
    row.hidden = main?.style.display === 'none';
    const params = new URL(selected.href, window.location.href).searchParams;
    root!.render(
      <>
        {!entry && <p role="status">当前成绩表已无原学生或题目的录入入口。原对象和草稿仍保留；请核实名单和权限后继续。</p>}
        <ClassroomFeedback
        key={selected.href}
        url={selected.href}
        compact
        recordingUnavailable={!entry}
        target={{
          studentUid: Number(selected.uid),
          pid: Number(selected.pid),
          ...(params.has('nodeId') ? { nodeId: Number(params.get('nodeId')) } : {}),
          ...(params.get('rid') ? { rid: params.get('rid')! } : {}),
        }}
        />
      </>,
    );
  };
  document.addEventListener('click', (event) => {
    const entry = (event.target as HTMLElement).closest<HTMLAnchorElement>('.cf-scoreboard-entry');
    if (!entry || UiContext.tdoc?.rule !== 'course') return;
    event.preventDefault();
    if (selected?.href === entry.href && row?.isConnected) {
      root?.unmount();
      row.remove();
      root = null;
      row = null;
      selected = null;
      return;
    }
    selected = { uid: entry.dataset.feedbackUid!, pid: entry.dataset.feedbackPid!, href: entry.href };
    sync();
  });
  return sync;
}
