import $ from 'jquery';
import { addPage, NamedPage, UserSelectAutoComplete } from '@hydrooj/ui-default';

const page = new NamedPage(['domain_class_edit', 'domain_class_create'], () => {
  console.log('Domain class edit page script loaded');
  const $teachers = $('[name="teachers"]');
  const $students = $('[name="students"]');

  if ($teachers.length) {
    UserSelectAutoComplete.getOrConstruct<UserSelectAutoComplete<true>>($teachers, { multi: true, clearDefaultValue: false });
    console.log('UserSelectAutoComplete attached to teachers');
  }
  if ($students.length) {
    UserSelectAutoComplete.getOrConstruct<UserSelectAutoComplete<true>>($students, { multi: true, clearDefaultValue: false });
    console.log('UserSelectAutoComplete attached to students');
  }
});

addPage(page);

export default page;
