import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';
import { getFeedbackSource, openFeedback } from './index';

export default new AutoloadPage('feedbackPage', () => {
  $(document).on('click', '[data-feedback-open]', (event) => {
    event.preventDefault();
    const source = getFeedbackSource(document.querySelector('[data-feedback-url]'));
    if (source) openFeedback(source);
  });
});
