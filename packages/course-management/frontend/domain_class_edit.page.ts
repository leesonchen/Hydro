import $ from 'jquery';
import {
  ActionDialog,
  CustomSelectAutoComplete,
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

  const templates = (window as any).UiContext?.templates || [];
  const $addCourse = $('[name="add_course"]');
  if ($addCourse.length) {
    const dialogContent = $(tpl`
      <div>
        <div class="row"><div class="columns">
          <h1>${i18n('Add Course')}</h1>
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
    const templateSelect = CustomSelectAutoComplete.getOrConstruct(dialogContent.find('[name="template"]'), {
      multi: true,
      data: templates.map((t) => ({ _id: t._id, name: t.title })),
      allowEmptyQuery: true,
      clearDefaultValue: false,
    });
    const addCourseDialog = new ActionDialog({
      $body: dialogContent,
      onDispatch(action) {
        const val = addCourseDialog.$dom.find('[name="template"]').val() as string;
        if (action === 'ok' && !val) {
          addCourseDialog.$dom.find('[name="template"]').focus();
          return false;
        }
        return true;
      },
    });
    addCourseDialog.clear = function () {
      templateSelect?.clear?.();
      addCourseDialog.$dom.find('[name="template"]').val('');
      return this;
    };

    $addCourse.on('click', async () => {
      if (!templates.length) {
        Notification.error(i18n('No available course templates.'));
        return;
      }
      const action = await addCourseDialog.clear().open();
      if (action !== 'ok') return;
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
