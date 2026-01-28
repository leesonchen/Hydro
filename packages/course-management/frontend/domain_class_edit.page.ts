import $ from 'jquery';
import UserSelectAutoComplete from '@hydrooj/ui-default/components/autocomplete/UserSelectAutoComplete';
import { NamedPage } from '@hydrooj/ui-default/misc/Page';

const page = new NamedPage(['domain_class_edit', 'domain_class_create'], () => {
  UserSelectAutoComplete.getOrConstruct<UserSelectAutoComplete<true>>($('[name="teachers"]'), { multi: true, clearDefaultValue: false });
  UserSelectAutoComplete.getOrConstruct<UserSelectAutoComplete<true>>($('[name="students"]'), { multi: true, clearDefaultValue: false });
});

export default page;
