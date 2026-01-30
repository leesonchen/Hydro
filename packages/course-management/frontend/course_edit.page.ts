import $ from 'jquery';
import {
  addPage,
  CustomSelectAutoComplete,
  NamedPage,
  ProblemSelectAutoComplete,
} from '@hydrooj/ui-default';
import { api } from '@hydrooj/ui-default/utils';

const page = new NamedPage(['course_edit', 'course_create'], () => {
  (async () => {
    const $assign = $('[name="assign"]');
    if ($assign.length) {
      // Force replace existing autocomplete if any (contest_edit might have attached one)
      if ($assign.data('autocomplete')) {
        $assign.data('autocomplete')?.destroy?.();
        $assign.removeData('autocomplete');
        $('.autocomplete-dummy[data-name="assign"]').remove();
        $assign.show();
      }

      const groups: any[] = await api('groups', {}, ['name', 'uids', 'students', 'class', 'archive']);
      const classes = (groups || [])
        .filter((g: any) => g && g.class && !g.archive && g.name !== 'teachers')
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
    }

    if ($('[name="isTemplate"]').length && $assign.length) {
      $assign.val('teachers');
    }
  })().catch(() => undefined);

  // Local datetime picker to avoid touching ui-default
  const flatpickr = (window as any).flatpickr;
  if (flatpickr) $('[data-pick-datetime]').each(function () {
    const $input = $(this);
    if ($input.data('fp-initialized')) return;
    flatpickr(this, {
      allowInput: true,
      enableTime: true,
      time_24hr: true,
      dateFormat: 'Y-m-d H:i',
    });
    $input.data('fp-initialized', true);
  });

  // DAG Visual Editor (default)
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

    const normalizeNodes = (data: any[]) => (Array.isArray(data) ? data : [])
      .map((node: any, idx: number) => {
        if (!node || typeof node !== 'object') return null;
        const normalized = node;
        normalized._id = Number.isFinite(+normalized._id) ? +normalized._id : idx + 1;
        normalized.title = (normalized.title ?? `标题 ${normalized._id}`) as string;
        normalized.pids = Array.from(new Set((normalized.pids || [])
          .map((p: any) => +p)
          .filter((p: any) => Number.isFinite(p) && p > 0)));
        normalized.requireNids = Array.from(new Set((normalized.requireNids || [])
          .map((n: any) => +n)
          .filter((n: any) => Number.isFinite(n) && n > 0)));
        return normalized;
      })
      .filter(Boolean) as any[];

    let nodes = normalizeNodes(parseDag() || []);

    const commit = (opts: { rerender?: boolean; source?: string } = {}) => {
      nodes = normalizeNodes(nodes).sort((a, b) => a._id - b._id);
      const nextJson = JSON.stringify(nodes, null, 2);
      const editorInstance = $dag.data('vjEditorInstance');
      const prevJson = editorInstance?.value ? editorInstance.value() : ($dag.val() as string);
      $dag.val(nextJson);
      if (editorInstance?.value) {
        editorInstance.value(nextJson);
      }
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
            + '<div class="section__header dag-node-header" style="display:flex; align-items:center; justify-content:space-between;">'
              + '<h3 class="section__title dag-node-title" style="margin:0;"></h3>'
              + '<div class="button-group" style="margin:0;">'
                + '<button type="button" class="rounded button small dag-remove">删除</button>'
              + '</div>'
            + '</div>'
            + '<div class="section__body">'
              + '<div class="row"><div class="columns">'
                + '<label>章节标题<input class="textbox dag-title" /></label>'
              + '</div></div>'
              + '<div class="row"><div class="columns">'
                + '<label>讲义标题（可选）<input class="textbox dag-lecture" placeholder="（无）" /></label>'
              + '</div></div>'
              + '<div class="row"><div class="columns">'
                + '<label>题目（必填，点击选择）<input class="textbox dag-problem-input" placeholder="搜索题目 (ID/标题)" /></label>'
              + '</div></div>'
              + '<div class="row"><div class="columns">'
                + '<label>前置章节（可选）<input class="textbox dag-deps" placeholder="（无）" /></label>'
              + '</div></div>'
              + '<div class="row dag-complete-row"><div class="columns">'
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
            + '</div>'
          + '</div>'
        );

        const $title = $section.find('.dag-title');
        const $deps = $section.find('.dag-deps');
        const $headerTitle = $section.find('.dag-node-title');
        const $problemInput = $section.find('.dag-problem-input');
        const $completeRow = $section.find('.dag-complete-row');
        const $completeType = $section.find('.dag-complete-type');
        const $completeValue = $section.find('.dag-complete-value');
        const $lecture = $section.find('.dag-lecture');

        $headerTitle.text(`章节 ${node._id}. ${node.title}`);
        $title.val(node.title);
        $title.on('input', () => {
          const nextTitle = String($title.val() || '').trim();
          $headerTitle.text(`章节 ${node._id}. ${nextTitle || ''}`);
        });
        const commitTitle = () => {
          node.title = String($title.val() || '').trim();
          commit({ source: 'title' });
        };
        $title.on('blur', commitTitle);
        $title.on('change', commitTitle);

        $lecture.val(typeof node.lecture === 'string' ? node.lecture : '');
        const commitLecture = () => {
          const nextLecture = String($lecture.val() || '').trim();
          if (nextLecture) {
            node.lecture = nextLecture;
          } else {
            delete node.lecture;
          }
          commit({ source: 'lecture' });
        };
        $lecture.on('blur', commitLecture);
        $lecture.on('change', commitLecture);

        const updateCompleteVisibility = () => {
          const hasDeps = (node.requireNids || []).length > 0;
          if (!hasDeps) {
            $completeRow.hide();
            return;
          }
          $completeRow.show();
          const type = String($completeType.val());
          if (type === 'all') {
            $completeValue.val('');
            $completeValue.hide();
          } else {
            $completeValue.show();
          }
        };

        $deps.val((node.requireNids || []).join(','));
        const updateDeps = (val: any) => {
          const ids = String(val || '')
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v.length)
            .map((v) => +v)
            .filter((v) => Number.isFinite(v) && v > 0);
          node.requireNids = Array.from(new Set(ids));
          updateCompleteVisibility();
        };
        $list.append($section);
        const depsSelect = CustomSelectAutoComplete.getOrConstruct($deps, {
          multi: true,
          data: nodeOptions.filter((n) => `${n._id}` !== `${node._id}`),
          allowEmptyQuery: true,
          freeSolo: true,
          clearDefaultValue: false,
        });
        depsSelect?.onChange?.((val: any) => {
          updateDeps(val);
          commit({ source: 'deps' });
        });
        $deps.on('blur', () => {
          updateDeps($deps.val());
          commit({ source: 'deps' });
        });
        $deps.on('change', () => {
          updateDeps($deps.val());
          commit({ source: 'deps' });
        });

        const condition = node.completeCondition || { type: 'all' };
        $completeType.val(condition.type || 'all');
        $completeValue.val(condition.value ?? '');
        updateCompleteVisibility();
        $completeType.on('change', () => {
          const type = String($completeType.val());
          updateCompleteVisibility();
          node.completeCondition = { type } as any;
          if (type !== 'all') {
            const val = Number($completeValue.val());
            if (Number.isFinite(val)) node.completeCondition.value = val;
          }
          commit({ source: 'complete type' });
        });
        const commitCompleteValue = () => {
          const type = String($completeType.val());
          const val = Number($completeValue.val());
          node.completeCondition = { type } as any;
          if (type !== 'all' && Number.isFinite(val)) node.completeCondition.value = val;
          commit({ source: 'complete value' });
        };
        $completeValue.on('blur', commitCompleteValue);
        $completeValue.on('change', commitCompleteValue);

        let lastProblemQuery = '';
        $problemInput.val((node.pids || []).join(','));
        const problemSelect = ProblemSelectAutoComplete.getOrConstruct($problemInput, {
          multi: true,
          allowEmptyQuery: true,
          freeSolo: false,
        });
        problemSelect?.onChange?.((val: any) => {
          const query = problemSelect?.ref?.getQuery?.() || '';
          if (query.trim()) lastProblemQuery = query.trim();
          const keys = Array.isArray(val) ? val : String(val || '').split(',');
          const ids = (keys as any[])
            .map((v) => +String(v).trim())
            .filter((v) => Number.isFinite(v));
          const next = (Array.from(new Set(ids)) as number[]).sort((a, b) => a - b);
          const current = (Array.from(new Set(node.pids || [])) as number[]).sort((a, b) => a - b);
          const same = next.length === current.length && next.every((v, i) => v === current[i]);
          if (same) return;
          node.pids = next;
          commit({ source: 'problem select' });
          if (lastProblemQuery) {
            problemSelect?.ref?.setQuery?.(lastProblemQuery);
          }
          problemSelect?.open?.();
        });

        $section.find('.dag-remove').on('click', () => {
          nodes = nodes.filter((n) => n._id !== node._id);
          commit({ rerender: true });
        });

      });
    };

    $addChapterBtn.on('click', () => {
      const maxId = Math.max(0, ...nodes.map((n) => n._id));
      nodes.push({
        _id: maxId + 1,
        title: `标题 ${maxId + 1}`,
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

    const $form = $dag.closest('form');
    $form.on('submit', (ev) => {
      commit({ source: 'submit' });
      if (!nodes.length) {
        ev.preventDefault();
        updateStatus('请至少保留一个章节', false);
        window.alert('请至少保留一个章节');
        return;
      }
      const emptyProblems = nodes.filter((n) => !(n.pids || []).length);
      if (emptyProblems.length) {
        ev.preventDefault();
        updateStatus('请为每个章节选择至少一道题目', false);
        window.alert('请为每个章节选择至少一道题目');
      }
    });

    $dag.on('input', updateStatusFromRaw);
    updateStatusFromRaw();
    setJsonVisible(false);
    render();
  }
});

addPage(page);

export default page;
