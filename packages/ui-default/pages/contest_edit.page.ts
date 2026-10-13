import $ from 'jquery';
import moment from 'moment';
import AssignSelectAutoComplete from 'vj/components/autocomplete/AssignSelectAutoComplete';
import LanguageSelectAutoComplete from 'vj/components/autocomplete/LanguageSelectAutoComplete';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
import UserSelectAutoComplete from 'vj/components/autocomplete/UserSelectAutoComplete';
import { confirm } from 'vj/components/dialog';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

const page = new NamedPage(['contest_edit', 'contest_create', 'homework_create', 'homework_edit'], (pagename) => {
  ProblemSelectAutoComplete.getOrConstruct($('[name="pids"]'), { multi: true, clearDefaultValue: false });
  UserSelectAutoComplete.getOrConstruct<true>($('[name="maintainer"]'), { multi: true, clearDefaultValue: false });
  LanguageSelectAutoComplete.getOrConstruct($('[name=langs]'), { multi: true });
  AssignSelectAutoComplete.getOrConstruct($('[name="assign"]'), { multi: true });
  $('[name="rule"]').on('change', () => {
    const rule = $('[name="rule"]').val();
    $('.contest-rule-settings input').attr('disabled', 'disabled');
    $('.contest-rule-settings').hide();
    $(`.contest-rule--${rule} input`).removeAttr('disabled');
    $(`.contest-rule--${rule}`).show();
  }).trigger('change');
  $('[name="beginAtDate"], [name="beginAtTime"], [name="duration"]').on('change', () => {
    const beginAtDate = $('[name="beginAtDate"]').val();
    const beginAtTime = $('[name="beginAtTime"]').val();
    const duration = $('[name="duration"]').val();
    const endAt = moment(`${beginAtDate} ${beginAtTime}`).add(+duration, 'hours').toDate();
    if (endAt) $('[name="endAt"]').val(moment(endAt).format('YYYY-MM-DD HH:mm'));
  });
  $('[name="permission"]').removeAttr('disabled').on('change', () => {
    const type = $('[name="permission"]').val();
    $('[data-perm] input').attr('disabled', 'disabled');
    $('[data-perm]').hide();
    $(`[data-perm="${type}"] input`).removeAttr('disabled');
    $(`[data-perm="${type}"]`).show();
  }).trigger('change');
  if (pagename.endsWith('edit')) {
    if (pagename === 'contest_edit') {
      const $form = $('[name="beginAtDate"]').closest('form');
      const schedule = () => JSON.stringify([
        moment(`${$('[name="beginAtDate"]').val()} ${$('[name="beginAtTime"]').val()}`).valueOf(),
        Number($('[name="duration"]').val()),
        $('[name="contestDuration"]').is(':disabled') ? null : Number($('[name="contestDuration"]').val()) || null,
      ]);
      const originalSchedule = schedule();
      let confirmedSchedule: string;
      $form.on('submit', async (ev) => {
        const submitter = (ev.originalEvent as SubmitEvent)?.submitter as HTMLButtonElement;
        if (submitter?.value === 'delete' || submitter?.hasAttribute('formaction')) return;
        const currentSchedule = schedule();
        if (currentSchedule === originalSchedule || currentSchedule === confirmedSchedule) return;
        ev.preventDefault();
        if (await confirm(i18n('修改时间可能影响成绩、罚时、提交有效性和积分结果。系统会保存修改记录，是否继续？'))) {
          confirmedSchedule = currentSchedule;
          ($form[0] as HTMLFormElement).requestSubmit(submitter || undefined);
        }
      });
    }
    let confirmed = false;
    $(document).on('click', '[value="delete"]', (ev) => {
      ev.preventDefault();
      if (confirmed) {
        return request.post('', { operation: 'delete' }).then((res) => {
          window.location.href = res.url;
        });
      }
      const message = `Confirm deleting this ${pagename.split('_')[0]}? Its files and status will be deleted as well.`;
      return confirm(i18n(message)).then((yes) => {
        if (yes) {
          confirmed = true;
          ev.target.click();
        }
      });
    });
    setInterval(() => {
      $('img').each(function () {
        if ($(this).attr('src').startsWith('file://')) {
          $(this).attr('src', $(this).attr('src').replace('file://', './file/'));
        }
      });
    }, 500);
  }
});

export default page;
