const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const nunjucks = require('nunjucks');
const { test } = require('node:test');
const ts = require('typescript');
const moment = require('moment-timezone');

const templatePath = path.resolve(__dirname, '../packages/ui-default/templates/contest_edit.html');
const template = fs.readFileSync(templatePath, 'utf8');

function renderContestEdit(overrides = {}) {
    const loader = new nunjucks.Loader();
    loader.getSource = (name) => {
        if (name === 'layout/basic.html') {
            return { src: '{% import "components/form.html" as form %}{% block content %}{% endblock %}', path: name };
        }
        if (name === 'partials/files.html') return { src: '', path: name };
        return null;
    };
    const env = new nunjucks.Environment([
        loader,
        new nunjucks.FileSystemLoader(path.resolve(__dirname, '../packages/ui-default/templates')),
    ]);
    env.addGlobal('_', (text) => Object.assign(new nunjucks.runtime.SafeString(text || ''), {
        format: (...values) => (text || '').replace(/\{(\d+)\}/g, (_match, index) => values[index]),
    }));
    env.addFilter('assign', (target, source) => ({ ...target, ...source }));
    env.addGlobal('datetimeSpan', (date, relative) => {
        assert.equal(relative, false, 'audit records must show exact times, not relative labels');
        return new Date(date).toISOString();
    });

    const beginAt = {
        format: () => '2026-10-12',
        clone: () => ({ add: () => ({ format: () => '2026-10-12 13:00' }) }),
    };
    const tdoc = {
        rule: 'oi',
        title: 'Rendered contest',
        assign: [],
        _code: '',
        monitorMode: 'browser',
        langs: 'cpp',
        allowPractice: true,
        hideInBanner: true,
        rated: true,
        autoHide: true,
        allowViewCode: true,
        allowPrint: true,
        allowTeam: true,
        keepScoreboardHidden: true,
        endAt: new Date('2026-10-12T15:00:00Z'),
        lockAt: new Date('2026-10-12T14:30:00Z'),
        duration: 1.5,
        files: [],
        ...overrides,
    };
    return env.renderString('{% import "components/form.html" as form %}' + template, {
        page_name: 'contest_edit',
        rules: { acm: 'ACM', oi: 'OI' },
        beginAt,
        duration: 3,
        pids: '100,101',
        tdoc,
        handler: {
            user: {
                hasPerm: () => true,
                own: () => true,
            },
            session: {},
            request: {},
        },
        perm: { PERM_EDIT_PROBLEM: 1, PERM_EDIT_CONTEST: 2 },
        url: () => '/contest',
        ...overrides,
    });
}

function formData(html) {
    const dom = new JSDOM(html);
    const form = dom.window.document.querySelector('form');
    assert.ok(form);
    return { dom, form, data: new dom.window.FormData(form) };
}

function initializeContestEditor(dom) {
    const $ = require('jquery')(dom.window);
    let initialize;
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../packages/ui-default/pages/contest_edit.page.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(code, {
        exports: {}, document: dom.window.document, window: dom.window, setInterval: () => 0,
        require: (name) => {
            if (name === 'jquery') return $;
            if (name === 'vj/misc/Page') return { NamedPage: class { constructor(_pages, callback) { initialize = callback; } } };
            if (name.startsWith('vj/components/autocomplete/')) return { getOrConstruct() {} };
            if (name === 'vj/components/dialog') return { confirm: async (message) => dom.window.confirm(message) };
            if (name === 'vj/utils') return { i18n: (text) => text, request: {} };
            return require(name);
        },
    });
    $('[name="beginAtDate"]').val('2026-10-12');
    $('[name="beginAtTime"]').val('08:00');
    initialize('contest_edit');
    return $;
}

function loadContestEditMethod(name, globals) {
    const file = path.resolve(__dirname, '../packages/hydrooj/src/handler/contest.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const handler = source.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'ContestEditHandler');
    const method = handler.members.find((node) => node.name?.getText(source) === name);
    const params = method.parameters.map((param) => param.getText(source)).join(', ');
    const exports = {};
    vm.runInNewContext(ts.transpileModule(`export async function ${name}(${params}) ${method.body.getText(source)}`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, ...globals }, { filename: file });
    return exports[name];
}

test('ordinary contest create and edit reject crafted monitoring requests before writes', async () => {
    let writes = 0;
    let problemReads = 0;
    const postUpdate = loadContestEditMethod('postUpdate', {
        ValidationError: Error,
        contest: {
            RULES: { oi: { hidden: false } },
            add: async () => { writes++; },
            edit: async () => { writes++; },
        },
        problem: { getList: async () => { problemReads++; } },
    });
    for (const tid of [undefined, 'ordinary-contest']) {
        for (const monitorMode of ['browser', 'invalid']) {
            const args = [
                'domain', tid, '2026-10-12', '08:00', 2, 'Title', '', 'oi', '1',
            ];
            args[23] = monitorMode;
            await assert.rejects(postUpdate.call({}, ...args), /monitorMode/);
        }
    }
    assert.equal(writes, 0);
    assert.equal(problemReads, 0);
});

test('saving an ordinary contest turns off existing monitoring and defaults new contests off', async () => {
    const savedModes = [];
    const postUpdate = loadContestEditMethod('postUpdate', {
        ValidationError: Error, moment,
        PERM: { PERM_VIEW_PROBLEM_HIDDEN: 1 },
        problem: { getList: async () => ({}) },
        ScheduleModel: { deleteMany: async () => {} },
        contest: {
            RULES: { oi: { hidden: false } },
            edit: async (_domainId, _tid, update) => { savedModes.push(update.monitorMode); },
            add: async (...args) => { savedModes.push(args[9].monitorMode); return 'new-contest'; },
        },
    });
    for (const tid of ['ordinary-contest', undefined]) {
        const context = {
            request: { body: {} }, response: {}, url: () => '/contest',
            user: { _id: 1, timeZone: 'UTC', hasPerm: () => true },
            tdoc: tid ? {
                beginAt: new Date('2026-10-12T08:00:00Z'), endAt: new Date('2026-10-12T10:00:00Z'),
                pids: [1], rule: 'oi', duration: null, monitorMode: 'browser',
            } : undefined,
        };
        await postUpdate.call(context, 'domain', tid, '2026-10-12', '08:00', 2, 'Title', '', 'oi', '1');
    }
    assert.deepEqual(savedModes, ['off', 'off']);
});

test('classroom tests cannot be edited through the ordinary contest endpoint', async () => {
    const prepare = loadContestEditMethod('prepare', {
        ForbiddenError: Error,
        contest: {
            get: async () => ({ rule: 'oi', sourceType: 'course_assessment', monitorMode: 'browser' }),
            RULES: { oi: { hidden: false } },
        },
    });
    await assert.rejects(prepare.call({}, 'domain', 'classroom-test'), /Edit classroom tests in course editor/);
});

test('contest time edits require confirmation but unchanged saves and clones do not', async () => {
    const { dom, form } = formData(renderContestEdit());
    try {
        const $ = initializeContestEditor(dom);
        let prompts = 0;
        let accept = false;
        dom.window.confirm = (message) => { prompts++; assert.match(message, /成绩、罚时/); return accept; };
        let resubmitted;
        form.requestSubmit = (submitter) => {
            resubmitted = new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter });
            form.dispatchEvent(resubmitted);
        };
        const save = async (submitter = form.querySelector('[value="update"]')) => {
            resubmitted = undefined;
            const event = new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter });
            form.dispatchEvent(event);
            await new Promise(setImmediate);
            return resubmitted || event;
        };
        assert.equal((await save()).defaultPrevented, false);
        assert.equal(prompts, 0);
        $('[name="duration"]').val('4').trigger('change');
        assert.equal((await save()).defaultPrevented, true);
        assert.equal(prompts, 1);
        accept = true;
        assert.equal((await save()).defaultPrevented, false);
        assert.equal(prompts, 2);
        assert.equal((await save(form.querySelector('[formaction]'))).defaultPrevented, false);
        assert.equal(prompts, 2);
        $('[name="duration"]').val('3').trigger('change');
        $('[name="beginAtTime"]').val('8:00');
        assert.equal((await save()).defaultPrevented, false);
        assert.equal(prompts, 2);
    } finally {
        dom.window.close();
    }
});

test('contest history is folded, newest first and marks rating impact', () => {
    const window = { beginAt: new Date('2026-10-12T08:00:00Z'), endAt: new Date('2026-10-12T09:00:00Z'), duration: null };
    const { dom } = formData(renderContestEdit({ timeChangeHistory: [
        { uid: 7, at: new Date('2026-10-12T08:10:00Z'), before: window, after: window, state: 'ongoing', attend: 2, ratingEnabled: true },
        { uid: 9, at: new Date('2026-10-12T08:20:00Z'), before: window, after: window, state: 'ongoing', attend: 2, ratingEnabled: false },
    ] }));
    try {
        const details = dom.window.document.querySelector('.contest-time-history');
        assert.ok(details);
        assert.equal(details.open, false);
        const rows = [...details.querySelectorAll('tbody tr')];
        assert.equal(rows.length, 2);
        assert.match(rows[0].textContent, /UID 9/);
        assert.match(rows[1].textContent, /UID 7/);
        assert.match(rows[1].textContent, /可能影响积分，需复核/);
        assert.match(rows[1].textContent, /2026-10-12T08:00:00.000Z/);
    } finally {
        dom.window.close();
    }
});

test('manual retry is a separate form and distinguishes saved settings from interrupted preparation', () => {
    for (const settingsSaved of [true, false]) {
        const { dom, form, data } = formData(renderContestEdit({
            statsRevision: 2,
            statsRecalc: { state: 'failed', revision: 2, settingsSaved },
        }));
        try {
            const retry = dom.window.document.querySelector('[data-retry-recalc]');
            assert.ok(retry);
            assert.equal(form.contains(retry), false, 'retry must not submit or validate the ordinary edit form');
            const retryData = new dom.window.FormData(retry);
            assert.equal(retryData.get('operation'), 'retry_recalc');
            assert.equal(retryData.get('statsRevision'), '2');
            assert.equal(retryData.get('title'), null);
            assert.equal(data.get('statsRevision'), null);
            assert.match(retry.parentElement.textContent, settingsSaved ? /设置已保存，成绩重算失败/ : /设置尚未保存/);
            assert.match(retry.parentElement.textContent, /手动重试|重试当前设置/);
        } finally { dom.window.close(); }
    }
});

test('contest editor renders persisted fields and only offers monitoring off', () => {
    const { dom, form, data } = formData(renderContestEdit());
    for (const name of [
        'rule', 'title', 'beginAtDate', 'beginAtTime', 'duration', 'endAt', 'pids', 'content',
        'maintainer', 'permission', 'assign', 'code', 'monitorMode', 'langs', 'allowPractice',
        'hideInBanner', 'rated', 'autoHide', 'allowViewCode', 'allowPrint', 'allowTeam',
        'keepScoreboardHidden', 'lock', 'contestDuration',
    ]) {
        assert.ok(form.elements.namedItem(name), `missing rendered field: ${name}`);
    }
    const monitorMode = form.elements.namedItem('monitorMode');
    assert.deepEqual([...monitorMode.options].map((option) => option.value), ['off']);
    assert.equal(monitorMode.value, 'off');
    assert.equal(data.get('monitorMode'), 'off');
    assert.match(monitorMode.closest('.form__item').textContent, /仅在课堂测试中试用/);
    assert.match(monitorMode.closest('.form__item').textContent, /保存后将关闭本场比赛已有的监控/);
    assert.deepEqual(data.getAll('allowPractice'), ['false', 'on']);
    assert.equal(data.get('hideInBanner'), 'on');
    assert.equal(data.get('rated'), 'on');
    assert.equal(data.get('allowPrint'), 'on');
    assert.equal(data.get('contestDuration'), null);
    dom.window.close();
});

test('rule changes keep native settings enabled only for compatible rules', () => {
    const { dom, form } = formData(renderContestEdit());
    const $ = require('jquery')(dom.window);
    let initialize;
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../packages/ui-default/pages/contest_edit.page.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
        exports: module.exports, document: dom.window.document,
        require: (name) => {
            if (name === 'jquery') return $;
            if (name === 'vj/misc/Page') return { NamedPage: class { constructor(_pages, callback) { initialize = callback; } } };
            if (name.startsWith('vj/components/autocomplete/')) return { getOrConstruct() {} };
            if (name === 'vj/components/dialog') return { confirm() {} };
            if (name === 'vj/utils') return { i18n: (text) => text, request: {} };
            return require(name);
        },
    });
    initialize('contest_create');

    const scoreboard = form.elements.namedItem('keepScoreboardHidden');
    const personalTime = form.elements.namedItem('contestDuration');
    assert.equal(scoreboard.disabled, false);
    assert.equal(personalTime.disabled, false);
    assert.equal(new dom.window.FormData(form).get('keepScoreboardHidden'), 'on');

    $('[name="rule"]').val('acm').trigger('change');
    assert.equal(scoreboard.disabled, true);
    assert.equal(personalTime.disabled, true);
    assert.equal(new dom.window.FormData(form).get('keepScoreboardHidden'), null);

    $('[name="rule"]').val('oi').trigger('change');
    assert.equal(scoreboard.disabled, false);
    assert.equal(personalTime.disabled, false);
    assert.equal(new dom.window.FormData(form).get('keepScoreboardHidden'), 'on');
    assert.equal(form.elements.namedItem('allowTeam').disabled, true);
    dom.window.close();
});

test('contest editor groups each setting by purpose without duplicating native checkbox labels', () => {
    const { dom, form } = formData(renderContestEdit());
    const groups = [...form.querySelectorAll('[data-contest-settings-group]')];
    assert.deepEqual(groups.map((group) => group.dataset.contestSettingsGroup), [
        'process', 'visibility', 'scoring',
    ]);
    const expected = {
        process: ['monitorMode', 'langs', 'allowPrint', 'contestDuration', 'lock'],
        visibility: ['hideInBanner', 'autoHide', 'allowViewCode', 'keepScoreboardHidden'],
        scoring: ['rated', 'allowTeam', 'allowPractice'],
    };
    for (const group of groups) {
        const groupName = group.dataset.contestSettingsGroup;
        for (const name of expected[groupName]) {
            assert.ok(group.querySelector('[name="' + name + '"]'), name + ' must be in ' + groupName);
        }
    }
    for (const name of ['hideInBanner', 'allowPrint', 'rated', 'allowTeam']) {
        const input = form.elements.namedItem(name);
        assert.equal(input.closest('.form__item').querySelectorAll('label').length, 1,
            name + ' must have one native checkbox label');
    }
    dom.window.close();
});

test('contest editor defaults monitoring off and preserves enabled team state', () => {
    const { dom, form, data } = formData(renderContestEdit({ monitorMode: undefined }));
    assert.equal(form.elements.namedItem('monitorMode').value, 'off');
    assert.equal(data.get('monitorMode'), 'off');

    const team = form.elements.namedItem('allowTeam');
    assert.equal(team.checked, true);
    assert.equal(team.disabled, true);
    assert.equal(data.get('allowTeam'), null);
    dom.window.close();
});

test('contest editor renders disabled conditional access and rule settings', () => {
    const { dom, form } = formData(renderContestEdit());
    for (const selector of [
        '[data-perm="assign"] input[name="assign"]',
        '[data-perm="invite"] input[name="code"]',
        '.contest-rule--acm input[name="lock"]',
        '.contest-rule--oi input[name="contestDuration"]',
    ]) {
        const field = form.querySelector(selector);
        assert.ok(field, `missing conditional field: ${selector}`);
        assert.equal(field.disabled, true);
    }
    assert.equal(form.querySelector('[data-perm="assign"]').style.display, 'none');
    assert.equal(form.querySelector('[data-perm="invite"]').style.display, 'none');
    assert.equal(form.querySelector('.contest-rule--oi input[name="keepScoreboardHidden"]').disabled, true);
    dom.window.close();
});
