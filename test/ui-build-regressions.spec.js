const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const webpack = require('webpack');

require('@hydrooj/register');
const config = require('../packages/ui-default/build/config/webpack').default;

test('real YAML worker builds without missing formatter exports or bundling Prettier', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-yaml-worker-'));
    try {
        const settings = await config();
        const compiler = webpack({
            mode: 'development', target: 'webworker', devtool: false,
            entry: require.resolve('monaco-yaml/yaml.worker.js'),
            module: settings.module, resolve: settings.resolve,
            plugins: settings.plugins.filter((plugin) => plugin instanceof webpack.NormalModuleReplacementPlugin),
            output: { path: folder, filename: 'worker.js' },
        });
        const stats = await new Promise((resolve, reject) => compiler.run((error, result) => {
            compiler.close((closeError) => error || closeError ? reject(error || closeError) : resolve(result));
        }));
        assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
        assert.equal(stats.hasWarnings(), false, stats.toString({ all: false, warnings: true }));
        const modules = stats.toJson({ all: false, modules: true }).modules;
        assert(modules.some((module) => module.name?.includes('disabled-format.ts')));
        assert(!modules.some((module) => /node_modules[\\/]prettier[\\/]/.test(module.name || '')));
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

test('YAML configuration keeps formatting disabled and the optional adapter preserves source', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../packages/ui-default/components/monaco/languages/yaml.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let settings;
    vm.runInThisContext('(function(require, module, exports, window) {\n' + compiled + '\n})')(
        (name) => {
            if (name === 'monaco-yaml') return { configureMonacoYaml: (_, value) => { settings = value; } };
            return {};
        }, { exports: {} }, {}, { location: { href: 'http://localhost/' } },
    );
    assert.equal(settings.format, false);
    assert.equal(settings.validate, true);
    const value = 'anchor: &item\n  a: 1\ncopy: *item\n';
    const { format } = require('../packages/ui-default/components/monaco/disabled-format');
    assert.equal(await format(value), value);
});

test('Node declarations stay text on both Windows and POSIX paths', async () => {
    const { module: { rules } } = await config();
    for (const resource of [
        'C:\\workspace\\node_modules\\@types\\node\\index.d.ts',
        'C:\\workspace\\node_modules\\@types\\node\\node_modules\\undici-types\\index.d.ts',
        '/workspace/node_modules/@types/node/index.d.ts',
        '/workspace/node_modules/@types/node/node_modules/undici-types/index.d.ts',
    ]) {
        const matches = rules.filter((rule) => !rule.resourceQuery && (!rule.test || rule.test.test(resource))
            && (!rule.include || [].concat(rule.include).some((pattern) => pattern.test(resource)))
            && (!rule.exclude || ![].concat(rule.exclude).some((pattern) => pattern.test(resource))));
        assert.equal(matches.length, 1, resource);
        assert(matches[0].type.startsWith('asset/'), resource);
    }
});

test('real webpack Node type context exports declaration strings without following their imports', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-type-context-'));
    try {
        const entry = path.join(folder, 'fixture.cjs');
        fs.writeFileSync(entry, "const types = require.context('@types/node/', true, /\\.d\\.ts$/, 'sync');\n"
            + 'module.exports = Object.fromEntries(types.keys().map(key => [key, types(key)]));\n');
        const { module: { rules } } = await config();
        const compiler = webpack({
            mode: 'development', entry, context: path.resolve(__dirname, '..'), devtool: false,
            resolve: { modules: [path.resolve(__dirname, '../node_modules')] },
            module: { rules },
            output: { path: folder, filename: 'types.cjs', library: { type: 'commonjs2' } },
        });
        const stats = await new Promise((resolve, reject) => compiler.run((error, result) => {
            compiler.close((closeError) => error || closeError ? reject(error || closeError) : resolve(result));
        }));
        assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
        const types = require(path.join(folder, 'types.cjs'));
        assert(Object.keys(types).length > 50);
        assert.equal(typeof types['./index.d.ts'], 'string');
        const dispatcher = Object.entries(types).find(([key]) => key.endsWith('undici-types/dispatcher.d.ts'));
        if (dispatcher) assert(dispatcher[1].includes('declare'));
        assert(types['./fs.d.ts'].includes('declare module "fs"'));
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

test('unsupported Monaco fallback and config updates keep YAML sequences unindented', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../packages/ui-default/components/problemconfig/ProblemConfigEditor.tsx'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    vm.runInThisContext('(function(require, module, exports, console) {\n' + compiled + '\n})')(
        (name) => {
            if (name === 'react-redux') return { connect: () => (component) => component };
            if (name === 'vj/components/editor') return {};
            if (name === 'vj/components/monaco/loader') return {
                load: async () => { throw new Error('Unsupported browser'); }, isMonacoUnsupportedError: () => true,
            };
            return require(name);
        }, module, module.exports, { warn() {} },
    );
    const Editor = module.exports.default;
    const first = { type: 'default', cases: [{ input: '1.in', output: '1.out' }], __valid: true };
    const component = new Editor({ config: first, handleUpdateCode() {} });
    let initial;
    component.initPlainTextarea = (value) => { initial = value; component.plainTextarea = { value }; };
    await component.componentDidMount();
    assert(initial.includes('cases:\n- input: 1.in\n  output: 1.out\n'), initial);
    component.props = { ...component.props, config: { ...first, cases: [{ input: '2.in', output: '2.out' }] } };
    component.componentDidUpdate({ config: first });
    assert(component.plainTextarea.value.includes('cases:\n- input: 2.in\n  output: 2.out\n'));
    assert.deepEqual(require('js-yaml').load(component.plainTextarea.value), {
        type: 'default', cases: [{ input: '2.in', output: '2.out' }],
    });
});

test('Monaco TypeScript loading accepts actual Node double quotes and every declared module', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../packages/ui-default/components/monaco/languages/typescript.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const libraries = new Map();
    const defaults = { setDiagnosticsOptions() {}, setCompilerOptions() {},
        addExtraLib: (content, uri) => libraries.set(uri, content) };
    const monaco = { languages: { typescript: { javascriptDefaults: defaults, typescriptDefaults: defaults,
        ScriptTarget: { ES2020: 7 }, ModuleKind: { ESNext: 99 } } },
    editor: { createModel() {} }, Uri: { parse: (uri) => uri } };
    const files = {
        './fs.d.ts': fs.readFileSync(require.resolve('@types/node/fs.d.ts'), 'utf8'),
        './legacy.d.ts': "declare module 'legacy' { }\ndeclare module 'node:legacy' { }",
    };
    const context = async (key) => files[key];
    context.keys = () => Object.keys(files);
    const mockRequire = () => monaco;
    mockRequire.context = () => context;
    const module = { exports: {} };
    vm.runInThisContext('(function(require, module, exports) {\n' + compiled + '\n})')(mockRequire, module, module.exports);
    await module.exports.loadTypes();
    assert.equal(libraries.get('ts:node/fs.d.ts'), files['./fs.d.ts']);
    const declaration = libraries.get('ts:node/require.d.ts');
    for (const id of ['fs', 'node:fs', 'legacy', 'node:legacy']) assert(declaration.includes("id:'" + id + "'"), id);
});
