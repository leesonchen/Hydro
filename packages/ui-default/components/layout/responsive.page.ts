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

  if (!row.classList.contains('responsive-sidebar-layout')) {
    row.classList.add('responsive-sidebar-layout');
    row.dataset.responsiveSidebarAdded = 'true';
  }
  if (columns.length === 2) row.classList.add('responsive-sidebar-layout--two-column');
  if (columns.length === 3 && columns[0].classList.contains('responsive-sidebar-secondary')) {
    enhanceSidebar(columns[0], 'Select User');
  }
  enhanceSidebar(sidebar, 'Page Tools');
  row.dataset.responsiveSidebarReady = 'true';
}

function restoreRow(row: HTMLElement) {
  Array.from(row.children).forEach((element) => {
    if (!(element instanceof HTMLElement) || !element.classList.contains('responsive-sidebar-column')) return;
    const content = Array.from(element.children)
      .find((child) => child.classList.contains('responsive-sidebar-content'));
    const toggle = Array.from(element.children)
      .find((child) => child.classList.contains('responsive-sidebar-toggle'));
    if (content && toggle) {
      while (content.firstChild) element.insertBefore(content.firstChild, toggle);
      content.remove();
      toggle.remove();
    }
    element.classList.remove('responsive-sidebar-column', 'responsive-sidebar-column--open');
  });
  row.classList.remove('responsive-sidebar-layout--two-column');
  if (row.dataset.responsiveSidebarAdded) row.classList.remove('responsive-sidebar-layout');
  delete row.dataset.responsiveSidebarAdded;
  delete row.dataset.responsiveSidebarReady;
}

function syncLayout() {
  const mode = document.documentElement.dataset.layoutMode;
  if (mode === 'wide') {
    document.querySelectorAll<HTMLElement>('.main > .row').forEach(enhanceRow);
  } else {
    document.querySelectorAll<HTMLElement>('.main > .row[data-responsive-sidebar-ready]').forEach(restoreRow);
  }
  document.querySelectorAll<HTMLButtonElement>('[data-layout-mode-option]').forEach((button) => {
    const selected = button.dataset.layoutModeOption === mode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

export default new AutoloadPage('responsiveSidebarPage', () => {
  syncLayout();
  $(document).on('vjContentNew.responsiveSidebar', syncLayout);
  $(document).on('vjDropdownShow.layoutMode', '[data-dropdown-target="#menu-footer-layout"]', syncLayout);
  $(document).on('click.layoutMode', '[data-layout-mode-option]', (event) => {
    const mode = (event.currentTarget as HTMLElement).dataset.layoutModeOption;
    if (mode !== 'classic' && mode !== 'wide') return;
    try { localStorage.setItem('hydro.layoutMode', mode); } catch (e) { /* Still switch this page. */ }
    document.documentElement.dataset.layoutMode = mode;
    syncLayout();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== 'hydro.layoutMode') return;
    document.documentElement.dataset.layoutMode = event.newValue === 'wide' ? 'wide' : 'classic';
    syncLayout();
  });
});
