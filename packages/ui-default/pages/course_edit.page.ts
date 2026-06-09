import $ from 'jquery';
import CustomSelectAutoComplete from 'vj/components/autocomplete/CustomSelectAutoComplete';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
import UserSelectAutoComplete from 'vj/components/autocomplete/UserSelectAutoComplete';
import { NamedPage } from 'vj/misc/Page';
import { api } from 'vj/utils';

const page = new NamedPage(['course_edit', 'course_create'], () => {
  const ensureAutocompleteMounted = (instance: any, retries = 4, delay = 80) => {
    if (!instance?.container || retries < 0) return;
    setTimeout(() => {
      if (!instance?.container?.isConnected) return;
      if (instance.container.childElementCount > 0) return;
      instance.attach?.();
      ensureAutocompleteMounted(instance, retries - 1, delay);
    }, delay);
  };

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
      ensureAutocompleteMounted(CustomSelectAutoComplete.getOrConstruct($assign));
    }

    if ($assign.length) {
      const isTemplate = $('[name="isTemplate"]').length > 0;
      const currentValue = String($assign.val() || '').trim();
      if (isTemplate && !currentValue) {
        $assign.val('teachers');
      }
      if (!isTemplate && currentValue === 'teachers') {
        $assign.val('');
      }
    }
    const $extraStudents = $('[name="extraStudents"]');
    if ($extraStudents.length) {
      const extraStudentsSelect = UserSelectAutoComplete.getOrConstruct<UserSelectAutoComplete<true>>($extraStudents, {
        multi: true,
        allowEmptyQuery: true,
        freeSolo: false,
      });
      ensureAutocompleteMounted(extraStudentsSelect);
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

  const parseLocalDateTime = (value: any) => {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const [, year, month, day, hour, minute] = match;
    const date = new Date(+year, +month - 1, +day, +hour, +minute);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  };

  const formatLocalDateTime = (date: Date) => {
    const pad = (value: number) => `${value}`.padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const $beginAt = $('[name="beginAt"]');
  const $lessonDuration = $('[name="lessonDurationHours"]');
  const $lessonBeginAt = $('[name="lessonBeginAt"]');
  const $lessonEndAt = $('[name="lessonEndAt"]');
  if ($beginAt.length && $lessonDuration.length && $lessonBeginAt.length && $lessonEndAt.length) {
    const getDurationHours = () => {
      const value = Number($lessonDuration.val());
      return Number.isFinite(value) && value > 0 ? value : 3;
    };
    const getDefaultLessonWindow = () => {
      const begin = parseLocalDateTime($beginAt.val());
      if (!begin) return null;
      const end = new Date(begin.getTime() + getDurationHours() * 60 * 60 * 1000);
      return {
        begin: formatLocalDateTime(begin),
        end: formatLocalDateTime(end),
      };
    };
    const initialDefaultWindow = getDefaultLessonWindow();
    let lessonWindowEdited = !!initialDefaultWindow
      && (String($lessonBeginAt.val() || '').trim() !== initialDefaultWindow.begin
        || String($lessonEndAt.val() || '').trim() !== initialDefaultWindow.end);
    const updateLessonWindow = () => {
      if (lessonWindowEdited) return;
      const next = getDefaultLessonWindow();
      if (!next) return;
      $lessonBeginAt.val(next.begin);
      $lessonEndAt.val(next.end);
    };
    $lessonBeginAt.add($lessonEndAt).on('input change', () => {
      lessonWindowEdited = true;
    });
    $beginAt.add($lessonDuration).on('input change', updateLessonWindow);
  }

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

    const remapNodeIds = (orderedNodes: any[]) => {
      const idMap = new Map<number, number>();
      orderedNodes.forEach((node, index) => {
        idMap.set(+node._id, index + 1);
      });
      orderedNodes.forEach((node, index) => {
        node._id = index + 1;
        node.requireNids = Array.from(new Set((node.requireNids || [])
          .map((id: any) => idMap.get(+id))
          .filter((id: any) => Number.isFinite(id) && id > 0 && id !== node._id)));
      });
    };

    const commit = (opts: { rerender?: boolean; source?: string } = {}) => {
      nodes = normalizeNodes(nodes).sort((a, b) => a._id - b._id);
      const nextJson = JSON.stringify(nodes, null, 2);
      const editorInstance = $dag.data('vjEditorInstance');
      $dag.val(nextJson);
      if (editorInstance?.isValid && editorInstance?.value) {
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

      nodes.forEach((node, nodeIndex) => {
        const $section = $(
          '<div class="training__section expanded dag-node">'
            + '<div class="section__header dag-node-header" style="display:flex; align-items:center; justify-content:space-between;">'
              + '<h3 class="section__title dag-node-title" style="margin:0;"></h3>'
              + '<div class="button-group" style="margin:0;">'
                + '<button type="button" class="rounded button small dag-move-up">上移</button>'
                + '<button type="button" class="rounded button small dag-move-down">下移</button>'
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
        const $moveUp = $section.find('.dag-move-up');
        const $moveDown = $section.find('.dag-move-down');

        $headerTitle.text(`章节 ${node._id}. ${node.title}`);
        $moveUp.prop('disabled', nodeIndex === 0);
        $moveDown.prop('disabled', nodeIndex === nodes.length - 1);
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
        const depsSelect = CustomSelectAutoComplete.getOrConstruct<CustomSelectAutoComplete<true>>($deps, {
          multi: true,
          data: nodeOptions.filter((n) => `${n._id}` !== `${node._id}`),
          allowEmptyQuery: true,
          freeSolo: true,
          clearDefaultValue: false,
        });
        ensureAutocompleteMounted(depsSelect);
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
        const clearProblemQuery = () => {
          lastProblemQuery = '';
          problemSelect?.ref?.setQuery?.('');
        };
        $problemInput.val((node.pids || []).join(','));
        const problemSelect = ProblemSelectAutoComplete.getOrConstruct<ProblemSelectAutoComplete>($problemInput, {
          multi: true,
          allowEmptyQuery: true,
          freeSolo: false,
        });
        ensureAutocompleteMounted(problemSelect);

        // Track the real visible input inside AutoComplete React component.
        const bindQueryTracker = () => {
          const input = problemSelect?.container?.querySelector('input') as HTMLInputElement | null;
          if (!input) return false;
          if ((input as any)._cmBound) return true;
          (input as any)._cmBound = true;
          input.addEventListener('input', () => {
            lastProblemQuery = input.value;
          });
          input.addEventListener('keydown', () => {
            lastProblemQuery = input.value;
          });
          return true;
        };

        // Try binding immediately, then retry if failed
        const tryBind = () => {
          if (!bindQueryTracker()) {
            ensureAutocompleteMounted(problemSelect, 1, 60);
            setTimeout(tryBind, 100);
          }
        };
        setTimeout(tryBind, 0);

        problemSelect?.onChange?.((val: any) => {
          const keys = Array.isArray(val) ? val : String(val || '').split(',');
          const ids = (keys as any[])
            .map((v) => +String(v).trim())
            .filter((v) => Number.isFinite(v));

          // 保留用户添加的顺序，去重但不排序
          const seen = new Set<number>();
          const next: number[] = [];
          for (const id of ids) {
            if (!seen.has(id)) {
              seen.add(id);
              next.push(id);
            }
          }

          const current = Array.isArray(node.pids) ? node.pids : [];
          const same = next.length === current.length && next.every((v, i) => v === current[i]);
          if (same) return;
          node.pids = next;
          commit({ source: 'problem select' });

          // 选择后保留搜索关键字（便于连续选择）
          const queryToRestore = lastProblemQuery;
          if (queryToRestore) {
            setTimeout(() => {
              const container = problemSelect?.container;
              const active = document.activeElement;
              if (!container || !active || !container.contains(active)) return;
              problemSelect?.ref?.setQuery?.(queryToRestore);
              problemSelect?.ref?.triggerQuery?.();
            }, 100);
          }
        });

        // 失焦到组件外时清除搜索关键字
        $section.on('focusout', () => {
          setTimeout(() => {
            const container = problemSelect?.container;
            const active = document.activeElement;
            if (container && active && container.contains(active)) return;
            clearProblemQuery();
          }, 0);
        });

        const moveNode = (direction: -1 | 1) => {
          const orderedNodes = normalizeNodes(nodes).sort((a, b) => a._id - b._id);
          const currentIndex = orderedNodes.findIndex((n) => n._id === node._id);
          const nextIndex = currentIndex + direction;
          if (currentIndex < 0 || nextIndex < 0 || nextIndex >= orderedNodes.length) return;
          [orderedNodes[currentIndex], orderedNodes[nextIndex]] = [orderedNodes[nextIndex], orderedNodes[currentIndex]];
          remapNodeIds(orderedNodes);
          nodes = orderedNodes;
          commit({ rerender: true, source: 'move' });
        };
        $moveUp.on('click', () => moveNode(-1));
        $moveDown.on('click', () => moveNode(1));

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
      // 提交时以 JSON textarea 的内容为准，不覆盖用户直接编辑的 JSON
      const currentParsed = parseDag();
      if (!currentParsed) {
        ev.preventDefault();
        window.alert('JSON 格式错误，请检查');
        return;
      }
      if (!currentParsed.length) {
        ev.preventDefault();
        updateStatus('请至少保留一个章节', false);
        window.alert('请至少保留一个章节');
        return;
      }
      // 同步到内存中的 nodes（但不写回 textarea）
      nodes = normalizeNodes(currentParsed);
    });

    $dag.on('input', updateStatusFromRaw);
    updateStatusFromRaw();
    setJsonVisible(false);
    render();
  }
});

export default page;
