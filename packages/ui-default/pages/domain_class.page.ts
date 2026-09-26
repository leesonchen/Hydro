import { NamedPage } from 'vj/misc/Page';

type SortMode = 'default' | 'asc' | 'desc';

const page = new NamedPage('domain_class', () => {
  const tbody = document.querySelector<HTMLTableSectionElement>('.domain-group tbody');
  const sortHeader = document.querySelector<HTMLElement>('[data-class-sort-header="name"]');
  const sortButton = sortHeader?.querySelector<HTMLButtonElement>('[data-class-sort="name"]');
  const sortIndicator = sortHeader?.querySelector<HTMLElement>('[data-class-sort-indicator]');
  const searchInput = document.querySelector<HTMLInputElement>('#classSearchInput');
  const noResultsRow = document.querySelector<HTMLElement>('[data-class-no-results]');
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('tr[data-gid]'));
  const defaultIndex = new Map(rows.map((row, index) => [row, index]));
  let sortMode: SortMode = 'default';

  const getClassName = (row: HTMLTableRowElement) => row.querySelector('.col--group')?.textContent?.trim() || '';

  const applySort = () => {
    const orderedRows = sortMode === 'default'
      ? [...rows]
      : [...rows].sort((left, right) => {
        const nameDiff = getClassName(left).localeCompare(getClassName(right), 'zh-CN');
        if (nameDiff !== 0) return sortMode === 'asc' ? nameDiff : -nameDiff;
        return defaultIndex.get(left)! - defaultIndex.get(right)!;
      });

    orderedRows.forEach((row) => tbody.appendChild(row));
    if (noResultsRow) tbody.appendChild(noResultsRow);

    const ariaSort = sortMode === 'asc' ? 'ascending' : sortMode === 'desc' ? 'descending' : 'none';
    sortHeader?.setAttribute('aria-sort', ariaSort);
    if (sortIndicator) sortIndicator.textContent = sortMode === 'asc' ? '↑' : sortMode === 'desc' ? '↓' : '↕';
  };

  const applyFilter = () => {
    const keyword = searchInput?.value.trim().toLowerCase() || '';
    let visibleCount = 0;
    rows.forEach((row) => {
      const visible = !keyword || getClassName(row).toLowerCase().includes(keyword);
      row.hidden = !visible;
      if (visible) visibleCount++;
    });
    if (noResultsRow) noResultsRow.hidden = !keyword || visibleCount > 0;
  };

  sortButton?.addEventListener('click', () => {
    sortMode = sortMode === 'default' ? 'asc' : sortMode === 'asc' ? 'desc' : 'default';
    applySort();
  });
  searchInput?.addEventListener('input', applyFilter);

  applySort();
  applyFilter();
});

export default page;
