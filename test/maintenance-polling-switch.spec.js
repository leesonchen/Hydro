const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('system setting server.maintenance_poll is declared correctly', () => {
    const settingFile = fs.readFileSync(
        path.resolve(__dirname, '../packages/hydrooj/src/model/setting.ts'),
        'utf8',
    );
    assert.match(
        settingFile,
        /Setting\('setting_server',\s*'server\.maintenance_poll',\s*false,\s*'boolean',\s*'server\.maintenance_poll'/,
        'server.maintenance_poll setting must be registered in setting_server with boolean type and default false',
    );

    const interfaceFile = fs.readFileSync(
        path.resolve(__dirname, '../packages/hydrooj/src/interface.ts'),
        'utf8',
    );
    assert.match(
        interfaceFile,
        /'server\.maintenance_poll':\s*boolean;/,
        'SystemKeys must include server.maintenance_poll boolean definition',
    );
});

test('UiContextBase includes maintenance_poll and base layer populates it', () => {
    const baseLayerFile = fs.readFileSync(
        path.resolve(__dirname, '../packages/hydrooj/src/service/layers/base.ts'),
        'utf8',
    );
    assert.match(
        baseLayerFile,
        /maintenance_poll:\s*boolean;/,
        'UiContextBase interface must define maintenance_poll',
    );
    assert.match(
        baseLayerFile,
        /maintenance_poll:\s*false,/,
        'UiContextBase object must default maintenance_poll to false',
    );
    assert.match(
        baseLayerFile,
        /UiContext\.maintenance_poll\s*=\s*!!system\.get\('server\.maintenance_poll'\);/,
        'base layer must populate UiContext.maintenance_poll from system.get',
    );
});

test('maintenance.page.ts checks UiContext.maintenance_poll before initializing', () => {
    const maintenancePage = fs.readFileSync(
        path.resolve(__dirname, '../packages/ui-default/components/maintenance/maintenance.page.ts'),
        'utf8',
    );
    assert.match(
        maintenancePage,
        /if\s*\(!UiContext\?\.maintenance_poll\)\s*return;/,
        'maintenancePage must return early if UiContext.maintenance_poll is falsy',
    );
    assert.match(
        maintenancePage,
        /const\s+POLL_INTERVAL\s*=\s*60000;/,
        'POLL_INTERVAL must be 60000 (60s)',
    );
});

test('locales define server.maintenance_poll without duplicated keys', () => {
    const yaml = require('js-yaml');
    for (const locale of ['zh', 'zh_TW', 'en']) {
        const filePath = path.resolve(__dirname, `../packages/hydrooj/locales/${locale}.yaml`);
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.load(content);
        assert.ok(parsed['server.maintenance_poll'], `${locale}.yaml must define server.maintenance_poll`);
    }
});
