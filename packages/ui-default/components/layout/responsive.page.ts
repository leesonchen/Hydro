import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

let nextSidebarId = 0;

function enhanceSidebar(sidebar: HTMLElement, label: string) {
  sidebar.classList.add('responsive-sidebar-column');

  const content = document.createElement('div');
  content.className = 'responsive-sidebar-content';
  content.id = `responsive-sidebar-${++nextSidebarId}`;
  while (sidebar.firstChild) content.append(sidebar.firstChild);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'responsive-sidebar-toggle';
  toggle.setAttribute('aria-controls', content.id);
  toggle.setAttribute('aria-expanded', 'false');
  const leadingIcon = document.createElement('span');
  leadingIcon.className = 'icon icon-settings';
  const text = document.createElement('span');
  text.textContent = i18n(label);
  const trailingIcon = document.createElement('span');
  trailingIcon.className = 'icon icon-expand_more';
  toggle.append(leadingIcon, text, trailingIcon);
  toggle.addEventListener('click', () => {
    const expanded = sidebar.classList.toggle('responsive-sidebar-column--open');
    toggle.setAttribute('aria-expanded', String(expanded));
  });
  sidebar.append(toggle, content);
}

function enhanceRow(row: HTMLElement) {
  if (row.dataset.responsiveSidebarReady) return;
  const columns = Array.from(row.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .filter((element) => element.classList.contains('columns'));
  const sidebar = columns.at(-1);
  if (!sidebar || columns.length < 2 || !/(?:^|\s)(?:medium|large)-[23](?:\s|$)/.test(sidebar.className)) return;

  row.classList.add('responsive-sidebar-layout');
  if (columns.length === 2) row.classList.add('responsive-sidebar-layout--two-column');
  if (columns.length === 3 && columns[0].classList.contains('responsive-sidebar-secondary')) {
    enhanceSidebar(columns[0], 'Select User');
  }
  enhanceSidebar(sidebar, 'Page Tools');
  row.dataset.responsiveSidebarReady = 'true';
}

function enhance() {
  if (document.documentElement.dataset.layoutMode !== 'wide') return;
  document.querySelectorAll<HTMLElement>('.main > .row').forEach(enhanceRow);
  document.documentElement.classList.toggle(
    'has-responsive-sidebar-layout',
    !!document.querySelector('.main > .responsive-sidebar-layout'),
  );
}

export default new AutoloadPage('responsiveSidebarPage', () => {
  enhance();
  $(document).on('vjContentNew.responsiveSidebar', enhance);
});
