import React from 'react';
import ReactDOM from 'react-dom/client';
import Schema from 'schemastery';
import Notification from 'vj/components/notification';
import DomComponent from 'vj/components/react/DomComponent';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

const page = new NamedPage('manage_config', async () => {
  if (document.documentElement.className.includes('theme--dark')) {
    document.documentElement.className += ' dark';
  }

  const [{ ConfigEditor, ComponentsProvider }, { isMonacoUnsupportedError, load }] = await Promise.all([
    import('@hydrooj/components'),
    import('vj/components/monaco/loader'),
  ]);
  let monaco;
  let registerAction: any = () => {};
  let renderMarkdown;
  try {
    ({ monaco, registerAction, renderMarkdown } = await load(['yaml']));
  } catch (e) {
    if (!isMonacoUnsupportedError(e)) throw e;
    console.warn('Monaco settings editor failed to load in this browser, falling back to textarea.', e);
  }

  function Markdown({ source }) {
    const rendered = React.useMemo(() => {
      if (!renderMarkdown) return '';
      const res = renderMarkdown({ value: source });
      const value = res.element.innerHTML;
      res.dispose();
      return value;
    }, [source, renderMarkdown]);
    if (!renderMarkdown) return <div>{source}</div>;
    // Markdown snippet come from trusted backend code, no need to sanitize here
    return <div dangerouslySetInnerHTML={{ __html: rendered }} />;
  }

  ReactDOM.createRoot(document.getElementById('app')!).render(
    <ComponentsProvider theme={UiContext.theme} codeFontFamily={UiContext.codeFontFamily} i18n={i18n}>
      <ConfigEditor
        schema={new Schema(UiContext.schema)}
        config={UiContext.config}
        monaco={monaco}
        registerAction={registerAction}
        Markdown={Markdown}
        onSave={(value) => {
          request.post('', { value }).then(() => {
            Notification.success(i18n('Changes saved successfully'));
            window.location.reload();
          }).catch((e) => {
            Notification.error(i18n('Failed to save changes:'), e.message);
          });
        }}
        sidebar={<DomComponent childDom={$('.section.side').get(0)} />}
        dynamic={UiContext.dynamic || {}}
      />
      <style>{`
        body {
          overflow: hidden;
        }
        .footer {
          visibility: hidden;
        }
        .omnibar-toggle {
          display: none;
        }
      `}
      </style>
    </ComponentsProvider>,
  );
});

export default page;
