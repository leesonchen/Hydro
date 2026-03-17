import $ from 'jquery';
import {
  ActionDialog,
  CustomSelectAutoComplete,
  DomainSelectAutoComplete,
  NamedPage,
  Notification,
  UserSelectAutoComplete,
  addPage,
  i18n,
  request,
  tpl,
} from '@hydrooj/ui-default';

const page = new NamedPage(['domain_class_edit', 'domain_class_create'], () => {
  const $teachers = $('[name="teachers"]');
  const $students = $('[name="students"]');
  const $teacherGroups = $('[name="teacherGroups"]');
  const $studentGroups = $('[name="studentGroups"]');
  const $intervalPreset = $('[name="intervalPreset"]');
  const $intervalDays = $('[name="intervalDays"]');
  const $intervalDaysContainer = $('#intervalDaysContainer');

  const teacherSelect = $teachers.length
    ? UserSelectAutoComplete.getOrConstruct<UserSelectAutoComplete<true>>($teachers, { multi: true, clearDefaultValue: false })
    : null;
  const studentSelect = $students.length
    ? UserSelectAutoComplete.getOrConstruct<UserSelectAutoComplete<true>>($students, { multi: true, clearDefaultValue: false })
    : null;

  const groups = (window as any).UiContext?.groups || [];
  const groupOptions = groups.map((g) => ({ _id: g.name, name: g.name, uids: g.uids || [] }));
  const groupMap = new Map<string, number[]>(groupOptions.map((g) => [g._id, g.uids || []]));

  const mergeGroupUids = (select: UserSelectAutoComplete<true> | null, groupNames: string[]) => {
    if (!select) return;
    const groupUids = groupNames.flatMap((name) => groupMap.get(String(name)) || []);
    const current = select.value() || [];
    const merged = Array.from(new Set([...(current as number[]), ...groupUids]));
    (select as any).ref?.setSelectedKeys?.(merged.map((uid) => uid.toString()));
  };

  if ($teacherGroups.length) {
    const teacherGroupSelect = CustomSelectAutoComplete.getOrConstruct($teacherGroups, {
      multi: true,
      data: groupOptions,
      allowEmptyQuery: true,
      clearDefaultValue: false,
    });
    teacherGroupSelect?.onChange?.(() => {
      const names = teacherGroupSelect.value() as string[];
      mergeGroupUids(teacherSelect, Array.isArray(names) ? names : []);
    });
  }

  if ($studentGroups.length) {
    const studentGroupSelect = CustomSelectAutoComplete.getOrConstruct($studentGroups, {
      multi: true,
      data: groupOptions,
      allowEmptyQuery: true,
      clearDefaultValue: false,
    });
    studentGroupSelect?.onChange?.(() => {
      const names = studentGroupSelect.value() as string[];
      mergeGroupUids(studentSelect, Array.isArray(names) ? names : []);
    });
  }

  const syncInterval = () => {
    if (!$intervalPreset.length) return;
    const preset = String($intervalPreset.val() || '1');
    if (preset === 'custom') {
      if ($intervalDaysContainer.length) $intervalDaysContainer.show();
      if ($intervalDays.length) {
        $intervalDays.prop('readonly', false);
        if (!$intervalDays.val()) $intervalDays.val('1');
      }
      return;
    }
    if ($intervalDaysContainer.length) $intervalDaysContainer.hide();
    if ($intervalDays.length) {
      $intervalDays.val(preset || '1');
      $intervalDays.prop('readonly', true);
    }
  };

  if ($intervalPreset.length) {
    syncInterval();
    $intervalPreset.on('change', syncInterval);
    if ($intervalDays.length) {
      $intervalDays.on('input', () => {
        if ($intervalPreset.val() !== 'custom') {
          $intervalPreset.val('custom');
          if ($intervalDaysContainer.length) $intervalDaysContainer.show();
          $intervalDays.prop('readonly', false);
        }
      });
    }
  }

  const currentDomainId = String((window as any).UiContext?.currentDomainId || '').trim();
  const availableSourceDomains = ((window as any).UiContext?.availableSourceDomains || []).map((domain: any) => ({
    _id: String(domain._id || ''),
    name: String(domain.name || domain._id || ''),
  }));
  const $addCourse = $('[name="add_course"]');
  if ($addCourse.length) {
    const dialogContent = $(tpl`
      <div>
        <div class="row"><div class="columns">
          <h1>${i18n('Add Course')}</h1>
        </div></div>
        <div class="row"><div class="columns">
          <label>
            ${i18n('Source Domain')}
            <input name="sourceDomain" type="text" class="textbox" autocomplete="off">
          </label>
        </div></div>
        <div class="row"><div class="columns">
          <label>
            ${i18n('Course Name')}
            <input name="template" type="text" class="textbox" autocomplete="off">
          </label>
        </div></div>
      </div>
    `);
    dialogContent.appendTo(document.body);
    const $sourceDomain = dialogContent.find('[name="sourceDomain"]');
    const $templateInput = dialogContent.find('[name="template"]');
    const sourceDomainSelect = DomainSelectAutoComplete.getOrConstruct($sourceDomain, {
      multi: false,
      allowEmptyQuery: true,
      freeSolo: false,
      selectedKeys: currentDomainId ? [currentDomainId] : [],
      queryItems: async (query: string) => {
        const normalized = String(query || '').trim().toLowerCase();
        return availableSourceDomains.filter((domain: any) => {
          if (!normalized) return true;
          return domain._id.toLowerCase().includes(normalized) || domain.name.toLowerCase().includes(normalized);
        });
      },
      itemText: (domain: any) => domain.name,
      itemKey: (domain: any) => domain._id,
    });
    let templateSelect = CustomSelectAutoComplete.getOrConstruct(dialogContent.find('[name="template"]'), {
      multi: true,
      data: [],
      allowEmptyQuery: true,
      clearDefaultValue: false,
    });
    let currentTemplates: Array<{ _id: string; name: string; title?: string; sourceDomainId?: string }> = [];
    let loadedSourceDomain = '';

    const getSelectedSourceDomain = () => {
      const selected = sourceDomainSelect.value?.() as any;
      if (selected && typeof selected === 'object') {
        return String(selected._id || '').trim().toLowerCase();
      }
      return String(selected || $sourceDomain.val() || '').trim().toLowerCase();
    };

    const applyTemplates = (templates: Array<{ _id: string; name: string; title?: string; sourceDomainId?: string }>) => {
      currentTemplates = templates;
      templateSelect?.detach?.();
      templateSelect = CustomSelectAutoComplete.getOrConstruct($templateInput, {
        multi: true,
        data: templates,
        allowEmptyQuery: true,
        clearDefaultValue: false,
      });
      templateSelect?.clear?.();
      $templateInput.val('');
    };

    const loadTemplates = async (sourceDomain: string) => {
      const normalized = String(sourceDomain || '').trim().toLowerCase();
      if (!normalized) {
        applyTemplates([]);
        loadedSourceDomain = '';
        return;
      }
      const res = await request.post('', {
        operation: 'get_templates',
        sourceDomain: normalized,
      });
      applyTemplates(Array.isArray(res.templates) ? res.templates : []);
      loadedSourceDomain = normalized;
    };

    const addCourseDialog = new ActionDialog({
      $body: dialogContent,
      onDispatch(action) {
        const sourceDomain = getSelectedSourceDomain();
        const val = addCourseDialog.$dom.find('[name="template"]').val() as string;
        if (action === 'ok' && !sourceDomain) {
          addCourseDialog.$dom.find('[name="sourceDomain"]').focus();
          return false;
        }
        if (action === 'ok' && !val) {
          addCourseDialog.$dom.find('[name="template"]').focus();
          return false;
        }
        return true;
      },
    });
    addCourseDialog.clear = function () {
      if (currentDomainId) {
        (sourceDomainSelect as any)?.ref?.setSelectedKeys?.([currentDomainId]);
        addCourseDialog.$dom.find('[name="sourceDomain"]').val(currentDomainId);
      } else {
        (sourceDomainSelect as any)?.ref?.setSelectedKeys?.([]);
        addCourseDialog.$dom.find('[name="sourceDomain"]').val('');
      }
      templateSelect?.clear?.();
      addCourseDialog.$dom.find('[name="template"]').val('');
      applyTemplates([]);
      loadedSourceDomain = '';
      return this;
    };

    const ensureTemplatesLoaded = async () => {
      const sourceDomain = getSelectedSourceDomain();
      if (!sourceDomain) {
        Notification.error(i18n('Source Domain is required.'));
        $sourceDomain.focus();
        return false;
      }
      if (loadedSourceDomain === sourceDomain && currentTemplates.length) return true;
      await loadTemplates(sourceDomain);
      if (!currentTemplates.length) {
        Notification.error(i18n('No available course templates.'));
        return false;
      }
      return true;
    };

    sourceDomainSelect?.onChange?.(async () => {
      const sourceDomain = getSelectedSourceDomain();
      if (!sourceDomain || sourceDomain === loadedSourceDomain) return;
      try {
        await loadTemplates(sourceDomain);
      } catch (e: any) {
        applyTemplates([]);
        loadedSourceDomain = '';
        Notification.error(e.message);
      }
    });

    $addCourse.on('click', async () => {
      const action = await addCourseDialog.clear().open();
      if (action !== 'ok') return;
      if (!await ensureTemplatesLoaded()) return;
      const value = addCourseDialog.$dom.find('[name="template"]').val() as string;
      try {
        const res = await request.post('', { operation: 'copy', template: value });
        if (res.error) {
          Notification.error(res.error.message || res.error);
          return;
        }
        Notification.success(i18n('Course added.'));
        if (res.tdocs?.length) {
          for (const tdoc of res.tdocs) {
            $('.course-tbody').append(tpl`
              <tr>
                <td class="col--course">${tdoc.title}</td>
                <td class="col--action">
                  <a class="typo-a" href="${tdoc.url}">${i18n('Visit')}</a>
                  · <a class="typo-a" href="${`${tdoc.url}/edit`}">${i18n('Edit')}</a>
                </td>
              </tr>
            `);
          }
        }
      } catch (e: any) {
        Notification.error(e.message);
      }
    });
  }
});

addPage(page);

export default page;
