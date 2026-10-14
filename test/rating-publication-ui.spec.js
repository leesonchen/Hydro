const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const nunjucks = require('nunjucks');
const { restore, restoration } = require('../tools/rating-publication-browser.cjs');

const templatesPath = path.resolve(__dirname, '../packages/ui-default/templates');
function environment() {
    const loader = new nunjucks.Loader();
    loader.getSource = (name) => {
        const sources = {
            'layout/basic.html': '{% block content %}{% endblock %}',
            'manage_base.html': '{% block manage_content %}{% endblock %}',
            'components/paginator.html': '{% macro render(page, count) %}<nav>Page {{ page }}</nav>{% endmacro %}',
            'components/nothing.html': '{% macro render(message) %}<p>{{ message }}</p>{% endmacro %}',
        };
        return Object.hasOwn(sources, name) ? { src: sources[name], path: name } : null;
    };
    const env = new nunjucks.Environment([loader, new nunjucks.FileSystemLoader(templatesPath)]);
    env.addGlobal('_', (value) => value || '');
    env.addGlobal('url', (name, args = {}) => `/${name}/${args.uid || ''}`);
    env.addGlobal('avatarUrl', (avatar) => avatar || 'avatar');
    env.addGlobal('ratingProvisionalEvents', 5);
    env.addGlobal('PRIV', { PRIV_USER_PROFILE: 1 });
    env.addGlobal('user', { render_inline: (udoc) => `<a>${udoc.uname}</a>` });
    env.addFilter('markdownInline', (value) => value || '');
    return env;
}

test('rating management page separates configuration from domain publication', () => {
    const html = environment().render('manage_rating.html', {
        dashboard: {
            config: { algorithm: 'v2_trial', domains: ['main'], revision: 4 },
            domains: [{
                domainId: 'main', name: '主分区', active: { algorithm: 'legacy', updatedAtText: '2026-10-12', previous: { runId: 'old' } },
                pending: false, job: { status: 'failed', error: '计算失败' },
                runs: [{ algorithm: 'v2_trial', status: 'failed', asOf: '2026-10-12', error: '计算失败' }],
                comparison: [{ uid: 7, legacyRp: 1420, rp: 1512.5, rating: null, ratedEvents: 2, achievement: 81, rank: 3, tier: 'TIER_2' }],
            }],
        },
        url: (name) => `/${name}`,
    });
    assert.match(html, /保存目标设置/);
    assert.match(html, /class="select-container" name="form_item_algorithm"/);
    assert.match(html, /class="textarea-container" name="form_item_domains"/);
    assert.match(html, /class="section__body rating-manage__actions"/);
    assert.match(html, /class="rating-manage__table-scroll"/);
    assert.match(html, /class="rating-manage__table-scroll rating-manage__table-scroll--comparison"/);
    assert.match(html, /保存设置只更新目标配置，不会自动切换/);
    assert.match(html, /name="domains" rows="4" class="textbox"/);

    assert.match(html, /普通做题记录只计入题目成就/);
    assert.match(html, /重算并应用/);
    assert.match(html, /恢复上一次评分/);
    assert.match(html, /计算失败/);
    assert.match(html, /前 20 名对照/);
    assert.match(html, /1512\.5/);
    assert.match(html, /未评级/);
    assert.match(html, /name="op" value="save"/);
    assert.match(html, /name="op" value="apply"/);
});

test('rating publication distinguishes a ready snapshot from an applied rating', () => {
    for (const status of ['queued', 'running', 'ready']) {
        const html = environment().render('manage_rating.html', {
            dashboard: { config: { algorithm: 'v2_trial', domains: ['main'] }, domains: [{
                domainId: 'main', name: '主分区', active: { algorithm: 'legacy' },
                job: { status }, runs: [], comparison: [],
            }] },
            url: (name) => `/${name}`,
        });
        assert.match(html, /重算并应用<\/button>/);
        assert.match(html, /<button[^>]*disabled[^>]*>重算并应用<\/button>/);
        if (status === 'ready') assert.match(html, /计算完成，待发布/);
    }
    const applied = environment().render('manage_rating.html', {
        dashboard: { config: { algorithm: 'v2_trial', domains: ['main'] }, domains: [{
            domainId: 'main', name: '主分区', active: { algorithm: 'v2_trial' },
            job: { status: 'complete' }, runs: [], comparison: [],
        }] },
        url: (name) => `/${name}`,
    });
    assert.match(applied, /已应用/);
    assert.match(applied, /<button[^>]*>重算并应用<\/button>/);
});

test('rating publication labels rollback records as rolled back', () => {
    const html = environment().render('manage_rating.html', {
        dashboard: { config: { algorithm: 'legacy', domains: ['main'] }, domains: [{
            domainId: 'main', name: '主分区', active: { algorithm: 'legacy' },
            job: { status: 'superseded', operation: 'rollback' },
            runs: [{ algorithm: 'v2_trial', status: 'superseded', operation: 'rollback' }], comparison: [],
        }] },
        url: (name) => `/${name}`,
    });
    assert.equal((html.match(/已回退/g) || []).length, 2);
    assert.doesNotMatch(html, /未应用/);
});

test('browser restoration uses rollback for an original run and records unavailable exact restoration', async () => {
    const original = { algorithm: 'v2_trial', domains: ['exam', 'main'] };
    const oldActive = { runId: 'original-run', algorithm: 'v2_trial', previous: { runId: 'legacy-run', algorithm: 'legacy' } };
    const dashboard = { config: { ...original }, domains: [{ domainId: 'exam', active: { runId: 'new-run', algorithm: 'v2_trial', previous: oldActive }, job: { status: 'complete' } }] };
    const browser = fakeAdmin(dashboard);
    resetRestoration();
    await restore(browser, original, oldActive);
    assert.equal(dashboard.domains[0].active.runId, 'original-run');
    assert.equal(restoration.publication, 'original-pointer-restored');
    assert.deepEqual(dashboard.config.domains, original.domains);
    assert.equal(restoration.config, true);

    const noActiveDashboard = { config: { algorithm: 'legacy', domains: ['exam'] }, domains: [{ domainId: 'exam', active: null, job: { status: 'complete' } }] };
    resetRestoration();
    await restore(fakeAdmin(noActiveDashboard), { algorithm: 'legacy', domains: ['exam'] }, oldActive);
    assert.equal(restoration.publication, 'failed');
    assert.ok(restoration.notes.some((note) => note.includes('cannot be restored')));
    assert.equal(restoration.config, true);

    const bootstrap = { runId: 'legacy-bootstrap', algorithm: 'legacy' };
    const alreadyLegacy = { config: { algorithm: 'legacy', domains: ['exam'] }, domains: [{ domainId: 'exam', active: bootstrap, job: { status: 'complete' } }] };
    const legacyBrowser = fakeAdmin(alreadyLegacy);
    resetRestoration();
    await restore(legacyBrowser, alreadyLegacy.config, null);
    assert.equal(restoration.publication, 'legacy-bootstrap-equivalent');
    assert.deepEqual(legacyBrowser.actions, []);

    const v2AfterBootstrap = { config: { algorithm: 'v2_trial', domains: ['exam'] }, domains: [{ domainId: 'exam',
        active: { runId: 'v2-run', algorithm: 'v2_trial', previous: bootstrap }, job: { status: 'complete' } }] };
    const v2Browser = fakeAdmin(v2AfterBootstrap);
    resetRestoration();
    await restore(v2Browser, v2AfterBootstrap.config, null);
    assert.equal(v2AfterBootstrap.domains[0].active.runId, 'legacy-bootstrap');
    assert.equal(restoration.publication, 'legacy-bootstrap-equivalent');
    assert.deepEqual(v2Browser.actions, ['rollback']);
});

function resetRestoration() {
    restoration.attempted = false;
    restoration.config = false;
    restoration.publication = 'not-started';
    restoration.notes = [];
}

function fakeAdmin(state) {
    const browser = { pendingOp: '', fields: {}, actions: [] };
    browser.send = async () => {};
    browser.waitFor = async () => {};
    browser.location = async () => '/manage/rating';
    browser.fill = async (selector, value) => { browser.fields[selector] = value; };
    browser.evaluate = async (script) => {
        if (script.startsWith('fetch(')) return state;
        if (script.includes('requestSubmit')) {
            if (script.includes("[value=save]")) {
                state.config.algorithm = browser.fields['select[name=algorithm]'];
                state.config.domains = browser.fields['textarea[name=domains]'].split('\n').filter(Boolean);
            }
            return;
        }
        const match = script.match(/value===("[^"]+")/);
        if (match) { browser.pendingOp = JSON.parse(match[1]); return `op:${browser.pendingOp}`; }
        return undefined;
    };
    browser.click = async () => {
        browser.actions.push(browser.pendingOp);
        const item = state.domains.find((entry) => entry.domainId === 'exam');
        if (browser.pendingOp === 'rollback') item.active = item.active?.previous || null;
        if (browser.pendingOp === 'apply') item.active = { runId: `run-${Date.now()}`, algorithm: state.config.algorithm === 'v2_trial' && state.config.domains.includes('exam') ? 'v2_trial' : 'legacy', previous: item.active };
    };
    browser.navigation = async () => {};
    return browser;
}

test('public ranking renders the simplified V2 score columns', () => {
    const html = environment().render('ranking.html', {
        ratingAlgorithm: 'v2_trial', ratingUpdatedAtText: '2026-10-12 16:30', ratingProvisionalEvents: 5, page: 1, upcount: 1,
        udocs: [{ _id: 7, uname: 'alice', rp: 1512.345, rating: null, ratedEvents: 2, nSubmit: 18, nAccept: 12,
            ratingAchievement: 81, rpInfo: { problem: 1500.12, contest: 1200.5 }, rank: 1,
            ratingTier: 'TIER_2', ratingTierName: '二级' }],
        model: { rp: {}, system: { get: () => 20 } },
        handler: { user: { hasPriv: () => false } },
    });
    assert.doesNotMatch(html, /限域试用|最近更新|试用 Rating/);
    assert.match(html, /综合分/);
    assert.match(html, /等级分/);
    assert.match(html, /测评场次/);
    assert.match(html, /成长值/);
    assert.match(html, /题目提交/);
    assert.match(html, /通过数/);
    assert.match(html, /未评级/);
    assert.match(html, /1500\.12/);
    assert.match(html, /18/);
    assert.match(html, /12/);
    assert.doesNotMatch(html, /成就 A|题目分 P|比赛分 C|分项 P \/ C/);
    assert.match(html, /1512\.35/);
    assert.doesNotMatch(html, /rp-problem/);
});

test('V2 inline user badge uses tier without legacy level class or badge', () => {
    const env = environment();
    const html = env.renderString('{% import "components/user.html" as user with context %}{{ user.render_inline(udoc) }}', {
        udoc: {
            _id: 7, uname: 'alice', avatar: '', ratingAlgorithm: 'v2_trial', ratingTier: 'TIER_2',
            ratingTierName: '二级', level: 8,
            hasPriv: () => false, hasPerm: () => false,
        },
        handler: { user: { hasPerm: () => false } },
        perm: { PERM_VIEW_USER_PRIVATE_INFO: 1, PERM_MOD_BADGE: 2 },
        PRIV: { PRIV_MOD_BADGE: 1 },
        UiContext: { cdn_prefix: '' },
    });
    assert.match(html, /二级/);
    assert.doesNotMatch(html, /uname--lv|badge--lv/);
});

test('V2 difficulty shows only qualified estimates and explains unavailable values', () => {
    const env = environment();
    const render = (fit) => env.render('partials/problem_v2_difficulty.html', { pdoc: { ratingV2Difficulty: fit } });
    const fit = { d: 1680.5, se: 42, students: 24, pos: 8, neg: 16, status: 'ok', provisionalLike: true };
    assert.match(render(fit), /1681/);
    assert.match(render(fit), /样本 24，通过 8 \/ 未通过 16，SE 42/);
    for (const [status, reason] of [['degenerate', '数据退化'], ['nonconverged', '拟合未收敛']]) {
        const html = render({ ...fit, d: 1500, status, se: null });
        assert.match(html, new RegExp(`暂无（${reason}）`));
        assert.doesNotMatch(html, /1500/);
    }
    assert.match(render({ ...fit, provisionalLike: false }), /暂无（样本不足或误差过大）/);
    assert.match(render(null), /暂无（无拟合数据）/);
});

test('V2 ranking headers and every user row have the same nine columns', () => {
    const html = environment().render('ranking.html', {
        ratingAlgorithm: 'v2_trial', page: 1, upcount: 1,
        udocs: [{ _id: 7, uname: 'alice', rp: 50, rating: 1500, nAccept: 2, nSubmit: 4 }],
        model: { rp: {}, system: { get: () => 20 } },
        handler: { user: { hasPriv: () => true, rp: 0, rating: null } },
    });
    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => (row[1].match(/<t[hd][\s>]/g) || []).length);
    assert.deepEqual(rows, [9, 9, 9]);
});
