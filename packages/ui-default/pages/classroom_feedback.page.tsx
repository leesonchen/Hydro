import React from 'react';
import ReactDOM from 'react-dom/client';
import ClassroomFeedback from 'vj/components/classroom-feedback';
import { NamedPage } from 'vj/misc/Page';

export default new NamedPage(['classroom_feedback', 'record_detail'], () => {
  const container = document.getElementById('classroom-feedback');
  if (container) {
    ReactDOM.createRoot(container).render(<ClassroomFeedback
    url={container.dataset.feedbackUrl || window.location.pathname + window.location.search}
    compact={!!container.dataset.feedbackUrl}
  />);
  }
});
