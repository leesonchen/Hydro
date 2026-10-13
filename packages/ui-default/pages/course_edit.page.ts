import flatpickr from 'flatpickr';
import $ from 'jquery';
import CustomSelectAutoComplete from 'vj/components/autocomplete/CustomSelectAutoComplete';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
import UserSelectAutoComplete from 'vj/components/autocomplete/UserSelectAutoComplete';
import { confirm } from 'vj/components/dialog';
import { NamedPage } from 'vj/misc/Page';
import { api } from 'vj/utils';
import { assessmentDateTimeToIso, formatDateTime, parseDateTime } from 'vj/utils/course-datetime';

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
      // The Save as Template submit button also exists on ordinary course pages.
      const isTemplate = $('input[type="hidden"][name="isTemplate"]').val() === 'true';
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

  const initDateTimePickers = ($inputs: JQuery) => {
    $inputs.each(function () {
      if ((this as HTMLInputElement & { _flatpickr?: unknown })._flatpickr) return;
      const assessmentTime = $(this).hasClass('dag-assessment-begin') || $(this).hasClass('dag-assessment-end');
      flatpickr(this, {
        allowInput: true,
        enableTime: true,
        time_24hr: true,
        enableSeconds: assessmentTime,
        dateFormat: assessmentTime ? 'Y-m-d H:i:S' : 'Y-m-d H:i',
      });
    });
  };
  initDateTimePickers($('[data-pick-datetime]'));

  const setDateTimeValue = ($input: JQuery, value: string) => {
    const picker = ($input[0] as HTMLInputElement & { _flatpickr?: flatpickr.Instance })?._flatpickr;
    if (picker) picker.setDate(value, false);
    else $input.val(value);
  };

  const courseTimeZone = $('[data-course-time-zone]').attr('data-course-time-zone')
    || new Intl.DateTimeFormat().resolvedOptions().timeZone;
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
      const begin = parseDateTime($beginAt.val(), courseTimeZone);
      if (!begin) return null;
      const end = new Date(begin.getTime() + getDurationHours() * 60 * 60 * 1000);
      return {
        begin: formatDateTime(begin, courseTimeZone),
        end: formatDateTime(end, courseTimeZone),
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
      setDateTimeValue($lessonBeginAt, next.begin);
      setDateTimeValue($lessonEndAt, next.end);
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
      + '</div>',
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
      $status.attr('role', ok ? 'status' : 'alert').text(message).css('color', ok ? 'green' : 'red');
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
        if (!String(normalized.lecture || '').trim()) {
          delete normalized.lectureRule;
        } else if (normalized.lectureRule?.pids?.length) {
          normalized.lectureRule = {
            pids: Array.from(new Set((normalized.lectureRule.pids || [])
              .map((p: any) => +p)
              .filter((p: any) => Number.isFinite(p) && p > 0))),
            condition: normalized.lectureRule.condition || { type: 'all' },
          };
          if (!normalized.lectureRule.pids.length) delete normalized.lectureRule;
        } else {
          delete normalized.lectureRule;
        }
        return normalized;
      })
      .filter(Boolean) as any[];

    let nodes = normalizeNodes(parseDag() || []);
    const originalAssessmentTimes = new Map(nodes
      .filter((node) => node.kind === 'assessment' && node.assessment?.contestTid)
      .map((node) => [node._id, {
        beginAt: new Date(node.assessment.beginAt).getTime(), endAt: new Date(node.assessment.endAt).getTime(),
      }]));
    let highWatermark = Math.max(Number($('[name="nodeIdHighWatermark"]').val()) || 0, ...nodes.map((node) => node._id));

    let render: () => void;
    const commit = (opts: { rerender?: boolean, source?: string } = {}) => {
      nodes = normalizeNodes(nodes);
      highWatermark = Math.max(highWatermark, ...nodes.map((node) => node._id));
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

    render = () => {
      $list.find('[data-pick-datetime]').each(function () {
        (this as HTMLInputElement & { _flatpickr?: flatpickr.Instance })._flatpickr?.destroy();
      });
      $list.empty();
      nodes = normalizeNodes(nodes);
      if (!nodes.length) {
        $list.append('<div class="typo">暂无章节，点击“新增章节”。</div>');
        return;
      }

      const nodeOptions = nodes.map((n, index) => ({
        _id: `${n._id}`,
        name: `${index + 1}. ${n.title}`,
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
              + '<div class="row"><div class="columns"><label>章节类型<select class="select dag-kind">'
              + '<option value="lesson">普通章节</option><option value="assessment">课堂测试</option></select></label></div></div>'
              + '<div class="row dag-assessment-row"><div class="columns"><label>赛制<select class="select dag-assessment-rule">'
              + '<option value="oi">OI</option><option value="ioi">IOI</option><option value="strictioi">Strict IOI</option>'
              + '<option value="acm">ACM</option></select></label></div></div>'
              + '<div class="row dag-assessment-row"><div class="columns">'
              + '<label>开始时间（浏览器本地时间）<input data-pick-datetime placeholder="YYYY-mm-dd HH:MM" class="textbox dag-assessment-begin" /></label></div>'
              + '</div>'
              + '<div class="row dag-assessment-row"><div class="columns">'
              + '<label>结束时间（浏览器本地时间）<input data-pick-datetime placeholder="YYYY-mm-dd HH:MM" class="textbox dag-assessment-end" />'
              + '</label></div></div>'
              + '<div class="row dag-assessment-row"><div class="columns"><label>'
              + '<span class="dag-assessment-pass-label">达标分数</span>（默认 0，须在考试结束且有提交记录后完成）'
              + '<input class="textbox dag-assessment-pass" type="number" min="0" step="1" />'
              + '</label></div></div>'
              + '<div class="row dag-assessment-row"><div class="columns"><label>考试监控<select class="select dag-assessment-monitor">'
              + '<option value="off">关闭</option><option value="browser">浏览器切屏提醒与记录</option></select></label></div></div>'
              + '<div class="row"><div class="columns">'
                + '<label>章节标题<input class="textbox dag-title" /></label>'
              + '</div></div>'
              + '<div class="row"><div class="columns">'
                + '<label>讲义标题（可选）<input class="textbox dag-lecture" placeholder="（无）" /></label>'
              + '</div></div>'
              + '<div class="row dag-lecture-rule-pids-row"><div class="columns">'
                + '<label>讲义解锁题目（可选，点击选择）<input class="textbox dag-lecture-rule-pids" placeholder="搜索题目 (ID/标题)" /></label>'
              + '</div></div>'
              + '<div class="row dag-lecture-rule-row"><div class="columns">'
                + '<label>讲义解锁条件'
                  + '<div class="input-group" style="display: flex; gap: 8px; align-items: center;">'
                    + '<select class="select dag-lecture-rule-type">'
                      + '<option value="all">全部通过</option>'
                      + '<option value="problem">通过题目数</option>'
                      + '<option value="score">通过总分</option>'
                    + '</select>'
                    + '<input class="textbox dag-lecture-rule-value" placeholder="数值" style="max-width: 140px;" />'
                  + '</div>'
                + '</label>'
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
          + '</div>',
        );

        const $title = $section.find('.dag-title');
        const $deps = $section.find('.dag-deps');
        const $headerTitle = $section.find('.dag-node-title');
        const $problemInput = $section.find('.dag-problem-input');
        const $completeRow = $section.find('.dag-complete-row');
        const $completeType = $section.find('.dag-complete-type');
        const $completeValue = $section.find('.dag-complete-value');
        const $lecture = $section.find('.dag-lecture');
        const $lectureRulePids = $section.find('.dag-lecture-rule-pids');
        const $lectureRulePidsRow = $section.find('.dag-lecture-rule-pids-row');
        const $lectureRuleRow = $section.find('.dag-lecture-rule-row');
        const $lectureRuleType = $section.find('.dag-lecture-rule-type');
        const $lectureRuleValue = $section.find('.dag-lecture-rule-value');
        const $moveUp = $section.find('.dag-move-up');
        const $moveDown = $section.find('.dag-move-down');

        $headerTitle.text(`课时 ${nodeIndex + 1}. ${node.title}`);
        $moveUp.prop('disabled', nodeIndex === 0);
        $moveDown.prop('disabled', nodeIndex === nodes.length - 1);
        const $kind = $section.find('.dag-kind');
        const $assessmentRows = $section.find('.dag-assessment-row');
        const $rule = $section.find('.dag-assessment-rule');
        const $begin = $section.find('.dag-assessment-begin');
        const $end = $section.find('.dag-assessment-end');
        const $pass = $section.find('.dag-assessment-pass');
        const $monitor = $section.find('.dag-assessment-monitor');
        $monitor.val(node.assessment?.monitorMode || 'off');
        function updateAssessmentMetric() {
          const acm = $rule.val() === 'acm';
          $section.find('.dag-assessment-pass-label').text(acm ? '达标通过题数' : '达标分数');
          $pass.attr('step', acm ? '1' : 'any');
          if (acm) $pass.attr('max', node.pids.length);
          else $pass.removeAttr('max');
        }
        $kind.val(node.kind || 'lesson');
        $rule.val(node.assessment?.rule || 'oi');
        updateAssessmentMetric();
        const toLocalTime = (value: string) => {
          if (!value) return '';
          const date = new Date(value);
          if (!Number.isFinite(date.getTime())) return '';
          return formatDateTime(date, undefined, true);
        };
        const originalBegin = node.assessment?.beginAt || '';
        const originalEnd = node.assessment?.endAt || '';
        const initialBeginDisplay = toLocalTime(originalBegin);
        const initialEndDisplay = toLocalTime(originalEnd);
        $begin.val(initialBeginDisplay);
        $end.val(initialEndDisplay);
        $pass.val(node.assessment?.passScore ?? 0);
        function syncAssessment() {
          node.kind = String($kind.val());
          $assessmentRows.toggle(node.kind === 'assessment');
          if (node.kind === 'assessment') {
            node.assessment = {
              ...(node.assessment || {}), rule: String($rule.val()),
              beginAt: assessmentDateTimeToIso($begin.val(), originalBegin, initialBeginDisplay),
              endAt: assessmentDateTimeToIso($end.val(), originalEnd, initialEndDisplay), rated: false,
              passScore: Math.max(0, Number($pass.val()) || 0), monitorMode: String($monitor.val() || 'off'),
            };
          } else delete node.assessment;
          updateAssessmentMetric();
          commit({ source: 'assessment' });
        }
        $kind.on('change', () => {
          if ($kind.val() === 'assessment' && node.kind !== 'assessment') {
            const defaultTime = ($input: JQuery) => {
              const date = parseDateTime($input.val(), courseTimeZone);
              return date ? formatDateTime(date, undefined, true) : '';
            };
            if (!$begin.val()) setDateTimeValue($begin, defaultTime($lessonBeginAt));
            if (!$end.val()) setDateTimeValue($end, defaultTime($lessonEndAt));
          }
          syncAssessment();
        });
        $rule.on('change', syncAssessment);
        $begin.on('change blur', syncAssessment);
        $end.on('change blur', syncAssessment);
        $pass.on('change blur', syncAssessment);
        $monitor.on('change', syncAssessment);
        $assessmentRows.toggle((node.kind || 'lesson') === 'assessment');
        $title.val(node.title);
        $title.on('input', () => {
          const nextTitle = String($title.val() || '').trim();
          $headerTitle.text(`课时 ${nodeIndex + 1}. ${nextTitle || ''}`);
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
            delete node.lectureRule;
          }
          commit({ source: 'lecture' });
        };
        $lecture.on('blur', commitLecture);
        $lecture.on('change', commitLecture);

        const updateLectureRuleVisibility = () => {
          const hasLecture = String($lecture.val() || '').trim().length > 0;
          $lectureRulePidsRow.toggle(hasLecture);
          if (!hasLecture) {
            $lectureRuleRow.hide();
            return;
          }
          const hasPids = !!node.lectureRule?.pids?.length;
          if (!hasPids) {
            $lectureRuleRow.hide();
            return;
          }
          $lectureRuleRow.show();
          const type = String($lectureRuleType.val());
          if (type === 'all') {
            $lectureRuleValue.val('');
            $lectureRuleValue.hide();
          } else {
            $lectureRuleValue.show();
          }
        };
        $lecture.on('input', updateLectureRuleVisibility);

        const setLectureRulePids = (val: any) => {
          const ids = (Array.isArray(val) ? val : String(val || '').split(','))
            .map((v: any) => +String(v).trim())
            .filter((v: any) => Number.isFinite(v) && v > 0);
          const pids = Array.from(new Set(ids));
          if (!pids.length) {
            delete node.lectureRule;
            updateLectureRuleVisibility();
            return;
          }
          node.lectureRule = {
            pids,
            condition: node.lectureRule?.condition || { type: 'all' },
          };
          updateLectureRuleVisibility();
        };

        $lectureRulePids.val((node.lectureRule?.pids || []).join(','));
        const lectureRuleSelect = ProblemSelectAutoComplete.getOrConstruct<ProblemSelectAutoComplete>($lectureRulePids, {
          multi: true,
          allowEmptyQuery: true,
          freeSolo: false,
        });
        ensureAutocompleteMounted(lectureRuleSelect);
        lectureRuleSelect?.onChange?.((val: any) => {
          setLectureRulePids(val);
          commit({ source: 'lecture rule pids' });
        });
        $lectureRulePids.on('blur', () => {
          setLectureRulePids($lectureRulePids.val());
          commit({ source: 'lecture rule pids' });
        });
        $lectureRulePids.on('change', () => {
          setLectureRulePids($lectureRulePids.val());
          commit({ source: 'lecture rule pids' });
        });

        const lectureRuleCondition = node.lectureRule?.condition || { type: 'all' };
        $lectureRuleType.val(lectureRuleCondition.type || 'all');
        $lectureRuleValue.val(lectureRuleCondition.value ?? '');
        updateLectureRuleVisibility();
        $lectureRuleType.on('change', () => {
          if (!node.lectureRule?.pids?.length) return;
          const type = String($lectureRuleType.val());
          updateLectureRuleVisibility();
          node.lectureRule.condition = { type } as any;
          if (type !== 'all') {
            const val = Number($lectureRuleValue.val());
            if (Number.isFinite(val)) node.lectureRule.condition.value = val;
          }
          commit({ source: 'lecture rule type' });
        });
        const commitLectureRuleValue = () => {
          if (!node.lectureRule?.pids?.length) return;
          const type = String($lectureRuleType.val());
          const val = Number($lectureRuleValue.val());
          node.lectureRule.condition = { type } as any;
          if (type !== 'all' && Number.isFinite(val)) node.lectureRule.condition.value = val;
          commit({ source: 'lecture rule value' });
        };
        $lectureRuleValue.on('blur', commitLectureRuleValue);
        $lectureRuleValue.on('change', commitLectureRuleValue);

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
        initDateTimePickers($section.find('[data-pick-datetime]'));
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
        $problemInput.val((node.pids || []).join(','));
        const problemSelect = ProblemSelectAutoComplete.getOrConstruct<ProblemSelectAutoComplete>($problemInput, {
          multi: true,
          allowEmptyQuery: true,
          freeSolo: false,
        });
        ensureAutocompleteMounted(problemSelect);
        const clearProblemQuery = () => {
          lastProblemQuery = '';
          problemSelect?.ref?.setQuery?.('');
        };

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
          const orderedNodes = normalizeNodes(nodes);
          const currentIndex = orderedNodes.findIndex((n) => n._id === node._id);
          const nextIndex = currentIndex + direction;
          if (currentIndex < 0 || nextIndex < 0 || nextIndex >= orderedNodes.length) return;
          [orderedNodes[currentIndex], orderedNodes[nextIndex]] = [orderedNodes[nextIndex], orderedNodes[currentIndex]];
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
      const maxId = Math.max(0, highWatermark, ...nodes.map((n) => n._id));
      highWatermark = maxId + 1;
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
    let confirmedAssessmentTimes: string;
    $form.on('submit', async (ev) => {
      // 提交时以 JSON textarea 的内容为准，不覆盖用户直接编辑的 JSON
      const currentParsed = parseDag();
      if (!currentParsed) {
        ev.preventDefault();
        setJsonVisible(true);
        const editorInstance = $dag.data('vjEditorInstance');
        if (editorInstance?.isValid) editorInstance.focus();
        else $dag.trigger('focus');
        return;
      }
      if (!currentParsed.length) {
        ev.preventDefault();
        updateStatus('请至少保留一个章节', false);
        setJsonVisible(true);
        const editorInstance = $dag.data('vjEditorInstance');
        if (editorInstance?.isValid) editorInstance.focus();
        else $dag.trigger('focus');
        return;
      }
      // 同步到内存中的 nodes（但不写回 textarea）
      nodes = normalizeNodes(currentParsed);
      const submitter = (ev.originalEvent as SubmitEvent)?.submitter as HTMLButtonElement;
      if (submitter?.value === 'delete' || submitter?.name === 'isTemplate') return;
      const timeChanged = nodes.some((node) => {
        const original = originalAssessmentTimes.get(node._id);
        return original && node.kind === 'assessment' && node.assessment
          && (original.beginAt !== new Date(node.assessment.beginAt).getTime()
            || original.endAt !== new Date(node.assessment.endAt).getTime());
      });
      const currentTimes = JSON.stringify(nodes.filter((node) => originalAssessmentTimes.has(node._id))
        .map((node) => [node._id, node.assessment?.beginAt, node.assessment?.endAt]));
      if (!timeChanged || confirmedAssessmentTimes === currentTimes) return;
      ev.preventDefault();
      if (await confirm('修改课堂测试时间可能影响成绩、罚时、课程达标状态、提交有效性和积分结果。系统会保存修改记录，是否继续？')) {
        confirmedAssessmentTimes = currentTimes;
        ($form[0] as HTMLFormElement).requestSubmit(submitter || undefined);
      }
    });

    $dag.on('input', updateStatusFromRaw);
    updateStatusFromRaw();
    setJsonVisible(false);
    render();
  }
});

export default page;
