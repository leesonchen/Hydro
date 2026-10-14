const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CsrfTokenError, Handler } = require('@hydrooj/framework');

function makeHandler(method, contentType, overrides = {}) {
    const handler = Object.create(Handler.prototype);
    handler.request = {
        method,
        host: 'hydro.example',
        headers: {
            'content-type': contentType,
            origin: 'https://attacker.example',
            ...overrides.headers,
        },
    };
    handler.context = {
        cors: false,
        cookies: { get: () => 'session-id' },
        ...overrides.context,
    };
    handler.allowCors = !!overrides.allowCors;
    return handler;
}

test('CSRF protection covers unsafe form methods and media type whitespace', async () => {
    await Promise.all(['post', 'put', 'patch', 'delete'].map((method) => assert.rejects(
        makeHandler(method, 'application/x-www-form-urlencoded ; charset=UTF-8').init(),
        CsrfTokenError,
    )));
});

test('CSRF protection does not apply to safe methods or bearer-authenticated requests', async () => {
    await makeHandler('get', 'application/x-www-form-urlencoded').init();
    await makeHandler('put', 'application/x-www-form-urlencoded', {
        headers: { authorization: 'Bearer api-token' },
    }).init();
});
