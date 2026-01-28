import $ from 'jquery';
import CustomSelectAutoComplete from '@hydrooj/ui-default/components/autocomplete/CustomSelectAutoComplete';
import { NamedPage } from '@hydrooj/ui-default/misc/Page';
import { api } from '@hydrooj/ui-default/utils';

const page = new NamedPage(['course_edit', 'course_create'], async () => {
  const $assign = $('[name="assign"]');
  if (!$assign.length) return;

  const groups: any[] = await api('groups', {}, ['name', 'uids', 'students', 'class']);
  const classes = (groups || [])
    .filter((g: any) => g && g.class)
    .map((g: any) => ({
      _id: g.name,
      name: `${g.name} (${(g.students || g.uids || []).length} users)`,
    }));

  CustomSelectAutoComplete.getOrConstruct($assign, {
    multi: false,
    data: classes,
    allowEmptyQuery: true,
    freeSolo: true,
    clearDefaultValue: false,
  });
});

export default page;
