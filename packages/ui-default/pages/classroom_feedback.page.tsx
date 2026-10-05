import React from 'react';
import ReactDOM from 'react-dom/client';
import ClassroomFeedback from 'vj/components/classroom-feedback';
import { NamedPage } from 'vj/misc/Page';

export default new NamedPage(['course_feedback', 'homework_feedback'], () => {
  const container = document.getElementById('classroom-feedback');
  if (container) ReactDOM.createRoot(container).render(<ClassroomFeedback url={window.location.pathname} />);
});
