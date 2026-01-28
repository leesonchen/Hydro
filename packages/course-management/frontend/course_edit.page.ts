import $ from 'jquery';
import {
  addPage,
  CustomSelectAutoComplete,
  NamedPage,
  ProblemSelectAutoComplete,
} from '@hydrooj/ui-default';
import { api } from '@hydrooj/ui-default/utils';

console.log('course_edit.page module loaded');

const page = new NamedPage(['course_edit', 'course_create'], () => {
  console.log('course_edit.page handler invoked');
  (async () => {
    console.log('course_edit.page async block started');
    const $assign = $('[name="assign"]');
    if ($assign.length) {
      // Force replace existing autocomplete if any (contest_edit might have attached one)
      if ($assign.data('autocomplete')) {
        console.log('Replacing existing autocomplete on assign');
        $assign.data('autocomplete')?.destroy?.();
        $assign.removeData('autocomplete');
        $('.autocomplete-dummy[data-name="assign"]').remove();
        $assign.show();
      }

      console.log('Fetching groups for assign autocomplete');
      const groups: any[] = await api('groups', {}, ['name', 'uids', 'students', 'class']);
      console.log('Groups fetched:', groups?.length);
      const classes = (groups || [])
        .filter((g: any) => g && g.class)
        .map((g: any) => ({
          _id: g.name,
          name: `${g.name} (${(g.students || g.uids || []).length} users)`,
        }));

      console.log('Constructing CustomSelectAutoComplete for classes:', classes.length);
      CustomSelectAutoComplete.getOrConstruct($assign, {
        multi: false,
        data: classes,
        allowEmptyQuery: true,
        freeSolo: true,
        clearDefaultValue: false,
      });
    }
  })().catch(err => console.error('course_edit.page async error:', err));

  // DAG Visual Editor (default)
  console.log('Initializing DAG visual editor');
  const $dag = $('textarea[name="dag"]');
  if ($dag.length) {
    const $dagRow = $dag.closest('.row');
    const $visual = $(
      '<div class="section dag-visual-editor">'
        + '<div class="section__header clearfix">'
          + '<h2 class="section__title" style="margin-top: 0;">课程计划</h2>'
        + '</div>'
        + '<div class="section__body">'
          + '<div class="row"><div class="columns">'
            + '<div class="button-group dag-editor-actions"></div>'
            + '<span class="dag-status" style="margin-left: 10px; font-size: 0.9em;"></span>'
          + '</div></div>'
          + '<div class="dag-visual-list"></div>'
        + '</div>'
      + '</div>'
    );
    const $actions = $visual.find('.dag-editor-actions');
    const $list = $visual.find('.dag-visual-list');
    const $status = $visual.find('.dag-status');

    const $addChapterBtn = $('<button type="button" class="rounded primary button small">新增章节</button>');
    const $toggleJsonBtn = $('<button type="button" class="rounded button small">显示 JSON</button>');
    const $reloadJsonBtn = $('<button type="button" class="rounded button small">从 JSON 重载</button>');
    $actions.append($addChapterBtn, $toggleJsonBtn, $reloadJsonBtn);
    $dagRow.before($visual);

    const setJsonVisible = (visible: boolean) => {
      const $monaco = $dag.next('.textbox');
      if (visible) {
        $dagRow.show();
        if ($monaco.length) $monaco.show();
        $toggleJsonBtn.text('隐藏 JSON');
      } else {
        $dagRow.hide();
        if ($monaco.length) $monaco.hide();
        $toggleJsonBtn.text('显示 JSON');
      }
    };

    const updateStatus = (message: string, ok = true) => {
      $status.text(message).css('color', ok ? 'green' : 'red');
    };

    const updateStatusFromRaw = () => {
      const raw = ($dag.val() as string) || '[]';
      try {
        JSON.parse(raw);
        updateStatus('JSON 已同步', true);
      } catch (e: any) {
        updateStatus(`JSON 错误: ${e.message}`, false);
      }
    };

    const parseDag = () => {
      const raw = ($dag.val() as string) || '[]';
      try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) throw new Error('DAG 必须是数组');
        updateStatus('JSON 已同步', true);
        return data;
      } catch (e: any) {
        updateStatus(`JSON 错误: ${e.message}`, false);
        return null;
      }
    };

    const normalizeNodes = (data: any[]) => (data || []).map((node: any, idx: number) => {
      const normalized = { ...node };
      normalized._id = Number.isFinite(+normalized._id) ? +normalized._id : idx + 1;
      normalized.title = (normalized.title ?? `章节 ${normalized._id}`) as string;
      normalized.pids = Array.from(new Set((normalized.pids || [])
        .map((p: any) => +p)
        .filter((p: any) => Number.isFinite(p))));
      if (normalized.requireNids) {
        normalized.requireNids = Array.from(new Set((normalized.requireNids || [])
          .map((n: any) => +n)
          .filter((n: any) => Number.isFinite(n))));
      }
      return normalized;
    });

    let nodes = normalizeNodes(parseDag() || []);

    const commit = (opts: { rerender?: boolean } = {}) => {
      nodes = normalizeNodes(nodes).sort((a, b) => a._id - b._id);
      $dag.val(JSON.stringify(nodes, null, 2));
      $dag.trigger('input');
      updateStatus('JSON 已同步', true);
      if (opts.rerender) render();
    };

    const render = () => {
      $list.empty();
      nodes = normalizeNodes(nodes).sort((a, b) => a._id - b._id);
      if (!nodes.length) {
        $list.append('<div class="typo">暂无章节，点击“新增章节”。</div>');
        return;
      }

      const nodeOptions = nodes.map((n) => ({
        _id: `${n._id}`,
        name: `${n._id}. ${n.title}`,
      }));

      nodes.forEach((node) => {
        const $section = $(
          '<div class="training__section expanded dag-node">'
            + '<div class="section__header clearfix">'
              + '<h3 class="section__title dag-node-title"></h3>'
              + '<div class="button-group" style="float: right;">'
                + '<button type="button" class="rounded button small dag-remove">删除</button>'
              + '</div>'
            + '</div>'
            + '<div class="section__body">'
              + '<div class="row"><div class="columns">'
                + '<label>章节标题<input class="textbox dag-title" /></label>'
              + '</div></div>'
              + '<div class="row"><div class="columns">'
                + '<label>前置章节<input class="textbox dag-deps" placeholder="例如: 1,2" /></label>'
              + '</div></div>'
              + '<div class="row"><div class="columns">'
                + '<label>前置章节完成条件'
                  + '<div class="input-group" style="display: flex; gap: 8px; align-items: center;">'
                    + '<select class="select dag-complete-type">'
                      + '<option value="all">全部通过</option>'
                      + '<option value="problem">通过题目数</option>'
                      + '<option value="score">通过总分</option>'
                    + '</select>'
                    + '<input class="textbox dag-complete-value" placeholder="数值" style="max-width: 140px;" />'
                  + '</div>'
                + '</label>'
              + '</div></div>'
              + '<div class="row"><div class="columns">'
                + '<label>题目（点击选择）<input class="textbox dag-problem-input" placeholder="搜索题目 (ID/标题)" /></label>'
              + '</div></div>'
            + '</div>'
          + '</div>'
        );

        const $title = $section.find('.dag-title');
        const $deps = $section.find('.dag-deps');
        const $headerTitle = $section.find('.dag-node-title');
        const $problemInput = $section.find('.dag-problem-input');
        const $completeType = $section.find('.dag-complete-type');
        const $completeValue = $section.find('.dag-complete-value');

        $headerTitle.text(`章节 ${node._id}. ${node.title}`);
        $title.val(node.title);
        $title.on('input', () => {
          const nextTitle = String($title.val() || '').trim();
          $headerTitle.text(`章节 ${node._id}. ${nextTitle || ''}`);
        });
        $title.on('blur', () => {
          node.title = String($title.val() || '').trim();
          commit();
        });

        $deps.val((node.requireNids || []).join(','));
        const updateDeps = (val: any) => {
          const ids = String(val || '')
            .split(',')
            .map((v) => +v.trim())
            .filter((v) => Number.isFinite(v));
          node.requireNids = Array.from(new Set(ids));
        };
        CustomSelectAutoComplete.getOrConstruct($deps, {
          multi: true,
          data: nodeOptions.filter((n) => `${n._id}` !== `${node._id}`),
          allowEmptyQuery: true,
          freeSolo: true,
          clearDefaultValue: false,
          onChange: (val: any) => {
            updateDeps(val);
          },
        });
        $deps.on('blur', () => {
          updateDeps($deps.val());
          commit();
        });

        const condition = node.completeCondition || { type: 'all' };
        $completeType.val(condition.type || 'all');
        $completeValue.val(condition.value ?? '');
        const updateCompleteVisibility = () => {
          const type = String($completeType.val());
          if (type === 'all') {
            $completeValue.val('');
            $completeValue.hide();
          } else {
            $completeValue.show();
          }
        };
        updateCompleteVisibility();
        $completeType.on('change', () => {
          const type = String($completeType.val());
          updateCompleteVisibility();
          node.completeCondition = { type } as any;
          if (type !== 'all') {
            const val = Number($completeValue.val());
            if (Number.isFinite(val)) node.completeCondition.value = val;
          }
          commit();
        });
        $completeValue.on('blur', () => {
          const type = String($completeType.val());
          const val = Number($completeValue.val());
          node.completeCondition = { type } as any;
          if (type !== 'all' && Number.isFinite(val)) node.completeCondition.value = val;
          commit();
        });

        ProblemSelectAutoComplete.getOrConstruct($problemInput, {
          multi: true,
          allowEmptyQuery: true,
          freeSolo: false,
          selectedKeys: (node.pids || []).map((pid: any) => String(pid)),
          onChange: (val: any) => {
            const ids = String(val || '')
              .split(',')
              .map((v) => +v.trim())
              .filter((v) => Number.isFinite(v));
            node.pids = Array.from(new Set(ids));
            commit();
          },
        });

        $section.find('.dag-remove').on('click', () => {
          nodes = nodes.filter((n) => n._id !== node._id);
          commit({ rerender: true });
        });

        $list.append($section);
      });
    };

    $addChapterBtn.on('click', () => {
      const maxId = Math.max(0, ...nodes.map((n) => n._id));
      nodes.push({
        _id: maxId + 1,
        title: `新章节 ${maxId + 1}`,
        pids: [],
        requireNids: [],
        completeCondition: { type: 'all' },
      });
      commit({ rerender: true });
    });

    $toggleJsonBtn.on('click', () => {
      const visible = !$dagRow.is(':visible');
      setJsonVisible(visible);
    });

    $reloadJsonBtn.on('click', () => {
      const parsed = parseDag();
      if (!parsed) return;
      nodes = normalizeNodes(parsed);
      render();
    });

    $dag.on('input', updateStatusFromRaw);
    updateStatusFromRaw();
    setJsonVisible(false);
    render();
  }
});

addPage(page);

export default page;
