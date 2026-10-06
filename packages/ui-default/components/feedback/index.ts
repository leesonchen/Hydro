import $ from 'jquery';
import { ActionDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { i18n, request, tpl } from 'vj/utils';

export interface FeedbackSource {
  url: string;
  title: string;
}

let dialogOpen = false;

export function getFeedbackSource(element: Element): FeedbackSource | null {
  const url = element?.getAttribute('data-feedback-url');
  const title = element?.getAttribute('data-feedback-title');
  return url && title ? { url, title } : null;
}

export function openFeedback(source: FeedbackSource, quote = '') {
  if (dialogOpen) return;
  if (quote.length > 4000) {
    Notification.error(i18n('Please select no more than 4000 characters for feedback.'));
    return;
  }
  dialogOpen = true;
  const $body = $(tpl`
    <form class="feedback-form">
      <h1>${i18n('Problem feedback')}</h1>
      <p class="feedback-form__source">${source.title}</p>
      <p class="supplementary">${i18n('Sent to the domain owner and copied to system administrators.')}</p>
      ${{ templateRaw: true, html: quote ? tpl`
        <label>${i18n('Quoted text')}
          <textarea class="textbox feedback-form__quote" rows="4" readonly>${quote}</textarea>
        </label>` : '' }}
      <label>${i18n('Describe the content problem')}
        <textarea class="textbox" name="content" rows="6" maxlength="2000" required data-autofocus></textarea>
      </label>
      <p class="supplementary">${i18n('You can add information and read replies in this feedback conversation in Messages.')}</p>
      <p class="feedback-form__error" role="alert" hidden></p>
    </form>`);
  let pending = false;
  const dialog = new ActionDialog({
    classes: 'feedback-dialog',
    width: '600px',
    $body,
    $action: tpl`
      <button class="rounded button" data-action="cancel">${i18n('Cancel')}</button>
      <button class="primary rounded button" data-action="ok">${i18n('Submit feedback')}</button>`,
    onDispatch: (action) => {
      if (pending) return false;
      if (action !== 'ok') return true;
      // The dialog is assigned before this event callback can run.
      // eslint-disable-next-line ts/no-use-before-define
      submit();
      return false;
    },
  });

  async function submit() {
    if (pending) return;
    const textarea = $body.find<HTMLTextAreaElement>('[name="content"]')[0];
    const content = textarea.value.trim();
    textarea.setCustomValidity(content ? '' : i18n('Please describe the content problem.'));
    if (!textarea.reportValidity()) return;
    pending = true;
    dialog.$dom.find('button, textarea[name="content"]').prop('disabled', true);
    $body.find('[role="alert"]').prop('hidden', true);
    try {
      const result = await request.post(source.url, { operation: 'feedback', content, quote });
      const url = `/home/messages?feedback=${encodeURIComponent(result.feedbackId)}`;
      dialog.$dom.find('.dialog__body').empty().append(tpl`
        <div class="typo">
          <h1>${i18n('Feedback submitted')}</h1>
          <p><a href="${url}">${i18n('View feedback')}</a></p>
        </div>`);
      dialog.$dom.find('.dialog__action').html(tpl`<button class="rounded button" data-action="cancel">${i18n('Close')}</button>`);
    } catch (error) {
      $body.find('[role="alert"]').text(error.message).prop('hidden', false);
    } finally {
      pending = false;
      dialog.$dom.find('button, textarea[name="content"]').prop('disabled', false);
    }
  }

  $body.on('submit', (event) => {
    event.preventDefault();
    submit();
  });
  $body.on('input', '[name="content"]', (event) => (event.currentTarget as HTMLTextAreaElement).setCustomValidity(''));
  dialog.open().finally(() => {
    dialogOpen = false;
    dialog.$dom.remove();
  });
}
