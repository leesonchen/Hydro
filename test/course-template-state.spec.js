const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { JSDOM } = require('jsdom');
const nunjucks = require('nunjucks');

const filename = path.resolve(__dirname, '../packages/ui-default/pages/course_edit.page.ts');
const helperFilename = path.resolve(__dirname, '../packages/ui-default/utils/course-datetime.ts');
const source = fs.readFileSync(filename, 'utf8');
const helperSource = fs.readFileSync(helperFilename, 'utf8');
const helperCompiled = ts.transpileModule(helperSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const dateTime = { exports: {} };
vm.runInNewContext(helperCompiled, { exports: dateTime.exports, require }, { filename: helperFilename });
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
}).outputText;
const templatesPath = path.resolve(__dirname, '../packages/ui-default/templates');

function renderCourseForm(isTemplate, assign, context = {}) {
    const loader = new nunjucks.Loader();
    loader.getSource = (name) => name === 'layout/basic.html'
        ? { src: '{% import "components/form.html" as form %}{% block content %}{% endblock %}', path: name }
        : null;
    const env = new nunjucks.Environment([
        loader,
        new nunjucks.FileSystemLoader(templatesPath),
    ]);
    env.addGlobal('_', (text) => text || '');
    env.addFilter('assign', (target, values) => ({ ...target, ...values }));
    return env.render('course_edit.html', {
        page_name: 'course_edit',
        isTemplate,
        tdoc: { title: 'Regression course', assign: assign || '' },
        assign,
        dag: JSON.stringify(context.dag || []),
        beginAtText: context.beginAtText || '', endAtText: '', lessonDurationHours: context.lessonDurationHours || '',
        lessonBeginAtText: context.lessonBeginAtText || '', lessonEndAtText: context.lessonEndAtText || '',
        templateCategoryOptions: [],
        assessmentTimeHistories: context.assessmentTimeHistories || [],
        url: () => '/course/1/edit',
        handler: { user: { hasPerm: () => true, own: () => true, timeZone: context.timeZone || 'UTC' } },
        perm: { PERM_EDIT_HOMEWORK: 1 },
    });
}

async function initializeCourse(html) {
    const dom = new JSDOM(html, { url: 'http://localhost/course/1/edit' });
    const $ = require('jquery')(dom.window);
    let initialize;
    const autocomplete = {
        getOrConstruct: () => ({ container: null }),
    };
    const mocks = {
        flatpickr: { default: (element) => { element._flatpickr = { setDate(value) { element.value = value; }, destroy() {} }; }, __esModule: true },
        jquery: $, 'vj/components/autocomplete/CustomSelectAutoComplete': autocomplete,
        'vj/components/autocomplete/ProblemSelectAutoComplete': autocomplete,
        'vj/components/autocomplete/UserSelectAutoComplete': autocomplete,
        'vj/components/dialog': { confirm: async (message) => dom.window.confirm(message) },
        'vj/misc/Page': { NamedPage: class { constructor(_names, callback) { initialize = callback; } } },
        'vj/utils/course-datetime': dateTime.exports,
        'vj/utils': { api: async () => [] },
    };
    const exports = {};
    vm.runInNewContext(compiled, {
        exports,
        window: dom.window,
        require: (name) => {
            assert.ok(Object.hasOwn(mocks, name), `unexpected module: ${name}`);
            return mocks[name];
        },
        setTimeout: () => 0,
        console,
    }, { filename });
    assert.equal(typeof initialize, 'function');
    initialize();
    await new Promise(setImmediate);
    return { dom, $ };
}

function readDag(dom) {
    return JSON.parse(dom.window.document.querySelector('[name="dag"]').value);
}

test('each failed classroom test has an independent retry form bound to its chapter and current revision', async () => {
    const { dom } = await initializeCourse(renderCourseForm(false, 'class-2026', {
        assessmentTimeHistories: [{
            title: 'Failed test', sourceNodeId: 7, statsRevision: 3,
            statsRecalc: { state: 'failed', settingsSaved: true, revision: 3 },
        }],
    }));
    try {
        const form = dom.window.document.querySelector('form');
        const retry = dom.window.document.querySelector('[data-retry-recalc]');
        assert.ok(retry);
        assert.equal(form.contains(retry), false);
        const data = new dom.window.FormData(retry);
        assert.equal(data.get('nodeId'), '7');
        assert.equal(data.get('statsRevision'), '3');
        assert.equal(data.get('operation'), 'retry_recalc');
        assert.equal(data.get('dag'), null);
        assert.equal(data.get('title'), null);
        assert.match(retry.parentElement.textContent, /设置已保存，成绩重算失败/);
    } finally { dom.window.close(); }
});

test('classroom time edits warn once per save and cancellation prevents saving', async () => {
    const dag = [{ _id: 1, title: 'Exam', kind: 'assessment', pids: [1], requireNids: [], assessment: {
        contestTid: 'fedcba987654fedcba987654', rule: 'oi',
        beginAt: '2026-10-12T08:00:00.123Z', endAt: '2026-10-12T09:00:00.456Z',
    } }];
    const { dom, $ } = await initializeCourse(renderCourseForm(false, 'class-2026', { dag }));
    try {
        let prompts = 0;
        let accept = false;
        dom.window.confirm = (message) => { prompts++; assert.match(message, /课程达标状态/); return accept; };
        const form = dom.window.document.querySelector('form');
        let resubmitted;
        form.requestSubmit = (submitter) => {
            resubmitted = new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter });
            form.dispatchEvent(resubmitted);
        };
        const save = async () => {
            resubmitted = undefined;
            const event = new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button') });
            form.dispatchEvent(event);
            await new Promise(setImmediate);
            return resubmitted || event;
        };
        assert.equal((await save()).defaultPrevented, false);
        assert.equal(prompts, 0);
        const changed = readDag(dom);
        changed[0].assessment.endAt = '2026-10-12T09:30:00.456Z';
        $('[name="dag"]').val(JSON.stringify(changed));
        assert.equal((await save()).defaultPrevented, true);
        assert.equal(prompts, 1);
        accept = true;
        assert.equal((await save()).defaultPrevented, false);
        assert.equal(prompts, 2);
        const templateSave = new dom.window.SubmitEvent('submit', {
            bubbles: true, cancelable: true, submitter: form.querySelector('[name="isTemplate"]'),
        });
        form.dispatchEvent(templateSave);
        assert.equal(templateSave.defaultPrevented, false);
        assert.equal(prompts, 2);
        $('[name="dag"]').val(JSON.stringify(dag));
        assert.equal((await save()).defaultPrevented, false);
        assert.equal(prompts, 2);
    } finally {
        dom.window.close();
    }
});

test('ordinary course with an empty assignment stays an ordinary course', async () => {
    const { dom, $ } = await initializeCourse(renderCourseForm(false, ''));
    try {
        assert.equal($('[name="assign"]').val(), '');
        assert.equal($('input[type="hidden"][name="isTemplate"]').length, 0);
    } finally {
        dom.window.close();
    }
});

test('ordinary course keeps its existing class assignment', async () => {
    const { dom, $ } = await initializeCourse(renderCourseForm(false, 'class-2026'));
    try {
        assert.equal($('[name="assign"]').val(), 'class-2026');
    } finally {
        dom.window.close();
    }
});

test('explicit template with an empty assignment is assigned to teachers', async () => {
    const { dom, $ } = await initializeCourse(renderCourseForm(true, ''));
    try {
        assert.equal($('[name="assign"]').val(), 'teachers');
    } finally {
        dom.window.close();
    }
});

test('Save as Template submits its button value without marking the page as a template', async () => {
    const { dom, $ } = await initializeCourse(renderCourseForm(false, 'class-2026'));
    try {
        const form = dom.window.document.querySelector('form');
        const submitter = form.querySelector('button[name="isTemplate"]');
        assert.equal(new dom.window.FormData(form).get('isTemplate'), null);
        assert.equal(new dom.window.FormData(form, submitter).get('isTemplate'), 'true');
        assert.equal($('input[type="hidden"][name="isTemplate"]').length, 0);
        assert.equal($('[name="assign"]').val(), 'class-2026');
    } finally {
        dom.window.close();
    }
});

test('assessment metric and monitor edits preserve original timestamp precision on blur', async () => {
    const beginAt = '2026-10-12T10:20:37.456Z';
    const endAt = '2026-10-12T12:30:49.789Z';
    const { dom, $ } = await initializeCourse(renderCourseForm(false, '', { dag: [{ _id: 1, title: 'Assessment', pids: [1, 2], kind: 'assessment', assessment: {
        rule: 'oi', beginAt, endAt, passScore: 10, monitorMode: 'off',
    } }] }));
    try {
        $('.dag-assessment-pass').val('15').trigger('blur');
        $('.dag-assessment-monitor').val('browser').trigger('change');
        let assessment = readDag(dom)[0].assessment;
        assert.equal(assessment.passScore, 15);
        assert.equal(assessment.monitorMode, 'browser');
        assert.equal(assessment.beginAt, beginAt);
        assert.equal(assessment.endAt, endAt);
        $('.dag-assessment-begin-date').trigger('blur');
        $('.dag-assessment-begin-time').trigger('blur');
        assessment = readDag(dom)[0].assessment;
        assert.equal(assessment.beginAt, beginAt);
        assert.equal(assessment.endAt, endAt);
    } finally {
        dom.window.close();
    }
});

test('editing one assessment bound changes only that bound', async () => {
    const beginAt = '2026-10-12T10:20:37.456Z';
    const endAt = '2026-10-12T12:30:49.789Z';
    const { dom, $ } = await initializeCourse(renderCourseForm(false, '', { dag: [{
        _id: 1, title: 'Assessment', pids: [1], kind: 'assessment', assessment: { rule: 'oi', beginAt, endAt, passScore: 0 },
    }] }));
    try {
        const changed = new Date(new Date(beginAt).getTime() + 60_000);
        const changedDisplay = dateTime.exports.formatDateTime(changed);
        const [changedDate, changedTime] = changedDisplay.split(' ');
        $('.dag-assessment-begin-date').val(changedDate).trigger('change');
        $('.dag-assessment-begin-time').val(changedTime).trigger('change');
        const assessment = readDag(dom)[0].assessment;
        const expectedBegin = dateTime.exports.parseDateTime(changedDisplay);
        const duration = Math.round((new Date(endAt).getTime() - new Date(beginAt).getTime()) / 60000);
        assert.equal(assessment.beginAt, expectedBegin.toISOString());
        assert.equal(assessment.endAt, new Date(expectedBegin.getTime() + duration * 60000).toISOString());
    } finally {
        dom.window.close();
    }
});

test('lesson wall time converts from profile zone to browser local time for assessment defaults', async () => {
    const priorTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
        const { dom, $ } = await initializeCourse(renderCourseForm(false, '', {
            timeZone: 'Asia/Tokyo', dag: [{ _id: 1, title: 'Lesson', pids: [], kind: 'lesson' }],
        }));
        try {
            $('[name="beginAt"]').val('2026-10-12 09:00').trigger('change');
            $('[name="lessonDurationHours"]').val('2').trigger('change');
            $('[name="lessonBeginAt"]').val('2026-10-12 09:00');
            $('[name="lessonEndAt"]').val('2026-10-12 11:00');
            $('.dag-kind').val('assessment').trigger('change');
            assert.equal($('.dag-assessment-begin-date').val(), '2026-10-11');
            assert.equal($('.dag-assessment-begin-time').val(), '17:00');
            assert.equal($('.dag-assessment-end').val(), '2026-10-11 19:00');
        } finally {
            dom.window.close();
        }
    } finally {
        if (priorTz === undefined) delete process.env.TZ;
        else process.env.TZ = priorTz;
    }
});

test('default lesson window follows profile-zone DST and invalid wall dates are rejected', async () => {
    const { dom, $ } = await initializeCourse(renderCourseForm(false, '', {
        timeZone: 'America/New_York',
    }));
    try {
        $('[name="beginAt"]').val('2026-03-08 01:30').trigger('change');
        $('[name="lessonDurationHours"]').val('2').trigger('change');
        assert.equal($('[name="lessonBeginAt"]').val(), '2026-03-08 01:30');
        assert.equal($('[name="lessonEndAt"]').val(), '2026-03-08 04:30');
    } finally {
        dom.window.close();
    }
    assert.equal(dateTime.exports.parseDateTime('2026-02-30 12:00', 'UTC'), null);
});
