const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('default and malformed avatars are local; explicit providers remain supported', () => {
  const source = read('packages/hydrooj/src/lib/avatar.ts');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, {
    exports,
    require(id) {
      if (id === '@hydrooj/framework/validator') return { Types: { Email: [null, () => true] } };
      if (id === '../utils') return { md5: () => 'hash' };
      throw new Error('Unexpected dependency: ' + id);
    },
    global: { Hydro: { model: { system: { get: () => '//cn.gravatar.com/avatar/' } } } },
  });
  const avatar = exports.default;
  assert.equal(avatar(''), '/img/avatar.png');
  assert.equal(avatar('invalid'), '/img/avatar.png');
  assert.equal(avatar('gravatar:'), '/img/avatar.png');
  assert.equal(avatar('foo:bar'), '/img/avatar.png');
  assert.equal(avatar('', 32, 'qq:12345'), '//q1.qlogo.cn/g?b=qq&nk=12345&s=160');
  assert.equal(avatar('gravatar:old@example.com'), '//cn.gravatar.com/avatar/hash?d=mm&s=64');
  assert.equal(avatar('github:octocat', 48), '//github.com/octocat.png?size=48');
  assert.equal(avatar('url:/file/42/.avatar.png'), '/file/42/.avatar.png');
});

test('new account and domain defaults do not generate remote Gravatar avatars', () => {
  const user = read('packages/hydrooj/src/model/user.ts');
  const home = read('packages/hydrooj/src/handler/home.ts');
  assert.match(user, /avatar:\s*''/);
  assert.doesNotMatch(user, /avatar:\s*\x60gravatar:\$\{mail\}\x60/);
  assert.doesNotMatch(user, /udict\[key\]\.avatar \|\|= \x60gravatar:/);
  assert.match(home, /avatar \|\|= this\.user\.avatar \|\| '';/);
  assert.match(home, /avatar: \x60url:\/file\//);
});

test('browser handles broken avatar images once, including dynamic lazy images', () => {
  let listener;
  vm.runInNewContext(read('packages/ui-default/components/avatarFallback.js'), {
    document: {
      addEventListener(name, handler, capture) {
        assert.equal(name, 'error');
        assert.equal(capture, true);
        listener = handler;
      },
    },
  });
  assert.equal(typeof listener, 'function');
  const makeImage = (marked, avatarClass) => {
    let src = 'https://cravatar.cn/avatar/abc';
    let writes = 0;
    let removed = false;
    return {
      tagName: 'IMG',
      hasAttribute(name) { return name === 'data-avatar-fallback' && marked; },
      classList: { contains(name) { return name === 'user-profile-avatar' && avatarClass; } },
      getAttribute(name) { return name === 'src' ? src : null; },
      removeAttribute(name) { if (name === 'srcset') removed = true; },
      get src() { return src; },
      set src(value) { src = value; writes++; },
      get writes() { return writes; },
      get removed() { return removed; },
    };
  };
  const broken = makeImage(true, false);
  listener({ target: broken });
  assert.equal(broken.src, '/img/avatar.png');
  assert.equal(broken.removed, true);
  listener({ target: broken });
  assert.equal(broken.writes, 1);
  const dynamic = makeImage(false, true);
  listener({ target: dynamic });
  assert.equal(dynamic.src, '/img/avatar.png');
  const unrelated = makeImage(false, false);
  listener({ target: unrelated });
  assert.equal(unrelated.writes, 0);
  listener({ target: { tagName: 'DIV' } });
});

test('all Hydro template avatarUrl image tags opt into fallback', () => {
  function scan(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const current = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(current);
      else if (current.endsWith('.html')) {
        const html = read(current);
        const avatars = [...html.matchAll(/src="\{\{ avatarUrl\(/g)];
        const marked = [...html.matchAll(/data-avatar-fallback src="\{\{ avatarUrl\(/g)];
        assert.equal(avatars.length, marked.length, current);
      }
    }
  }
  scan('packages/ui-default/templates');
  scan('packages/blog/templates');
});

test('XiaoLai uses checked local build assets with the OFL license', () => {
  const css = read('packages/ui-default/misc/typography.styl');
  const main = read('packages/ui-default/build/main.ts');
  const helper = read('packages/ui-default/build/downloadXiaolaiFont.ts');
  const webpack = read('packages/ui-default/build/config/webpack.ts');
  const license = read('packages/ui-default/misc/fonts/OFL.txt');
  assert.match(css, /src: url\('\.\/fonts\/Xiaolai-Regular\.ttf'\)/);
  assert.doesNotMatch(css, /raw\.githubusercontent\.com/);
  assert.match(main, /await ensureXiaolaiFont\(\)/);
  assert.match(helper, /e2f68daf0e72777a8cf58bc83de1b98634b251e537ddbfca24b0ae50d1802da2/);
  assert.match(webpack, /misc\/fonts\/OFL\.txt/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});
