const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const nunjucks = require('nunjucks');
const { test } = require('node:test');
const ts = require('typescript');

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

test('contest editor renders every persisted field and submits monitor mode', () => {
    const { dom, form, data } = formData(renderContestEdit());
    for (const name of [
        'rule', 'title', 'beginAtDate', 'beginAtTime', 'duration', 'endAt', 'pids', 'content',
        'maintainer', 'permission', 'assign', 'code', 'monitorMode', 'langs', 'allowPractice',
        'hideInBanner', 'rated', 'autoHide', 'allowViewCode', 'allowPrint', 'allowTeam',
        'keepScoreboardHidden', 'lock', 'contestDuration',
    ]) {
        assert.ok(form.elements.namedItem(name), `missing rendered field: ${name}`);
    }
    assert.equal(form.elements.namedItem('monitorMode').value, 'browser');
    assert.equal(data.get('monitorMode'), 'browser');
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
