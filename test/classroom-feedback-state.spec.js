const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../packages/ui-default/components/classroom-feedback-state.ts');
const loaded = new Module(filename, module);
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { createFeedbackState } = loaded.exports;
const receipt = (status = 200) => ({ ok: status === 200, status,
    json: async () => status === 200 ? { eventId: 'saved', recordedAt: '2026-10-06' } : { error: { message: 'denied' } } });
const operation = () => ({ url: '/feedback', body: { requestId: 'one-request', studentUid: 3, note: 'original' }, label: 'confirmed' });

test('lost receipt retains immutable request, retries the same operation and clears only its draft', async () => {
    const state = createFeedbackState();
    state.edit('original', { note: 'original', detail: '' });
    state.edit('other', { note: 'other student', detail: '' });
    const input = operation();
    let first;
    await state.send(input, async (_, options) => { first = options.body; throw Error('lost'); }, 'original');
    input.body.note = 'mutated';
    assert.equal(state.tone, 'unknown');
    await state.send(operation(), async () => { throw Error('must not send another command'); });
    let retry;
    await state.send(state.pending, async (_, options) => { retry = options.body; return receipt(); });
    assert.equal(first, retry);
    assert.equal(state.pending, null);
    assert.equal(state.confirmed, 1);
    assert(!state.drafts.has('original'));
    assert.equal(state.draft('other').note, 'other student');
});

test('a refused replay cannot claim the original write failed', async () => {
    const state = createFeedbackState();
    await state.send(operation(), async () => { throw Error('lost'); });
    const fixed = state.pending;
    await state.send(fixed, async () => receipt(403));
    assert.equal(state.pending, fixed);
    assert.equal(state.tone, 'unknown');
    assert.equal(state.confirmed, 0);
});

test('concurrent clicks send once and definite rejection retains the editable draft', async () => {
    const state = createFeedbackState();
    state.edit('one', { note: 'unsaved', detail: '' });
    let resolve;
    let calls = 0;
    const sending = state.send(operation(), async () => { calls++; return await new Promise((r) => { resolve = r; }); }, 'one');
    await state.send(operation(), async () => { calls++; return receipt(); });
    resolve(receipt(400));
    await sending;
    assert.equal(calls, 1);
    assert.equal(state.pending, null);
    assert.equal(state.draft('one').note, 'unsaved');
    assert.equal(state.tone, 'error');
});

test('resolution receipt carries an exact undo reference rather than retracting the original observation', async () => {
    const state = createFeedbackState();
    await state.send({ ...operation(), undo: { eventId: 'original', action: 'undo-resolve', version: 4 } }, async () => receipt());
    assert.deepEqual(state.undo, { eventId: 'original', action: 'undo-resolve', version: 4, resolutionId: 'saved' });
});

test('a malformed or redirected response remains unconfirmed', async () => {
    for (const response of [{ ...receipt(), redirected: true }, { ...receipt(), json: async () => ({}) }]) {
        const state = createFeedbackState();
        await state.send(operation(), async () => response);
        assert(state.pending);
        assert(state.hasUnsaved());
        assert.equal(state.confirmed, 0);
    }
});

test('drafts remain independent across teacher, lesson, problem and student contexts', () => {
    const state = createFeedbackState();
    state.edit('1:2:3:4', { note: 'kept across collapsing and remounting', detail: 'GUIDED:IDEA' });
    for (const key of ['9:2:3:4', '1:9:3:4', '1:2:9:4', '1:2:3:9']) assert.equal(state.draft(key).note, '');
    assert.equal(state.draft('1:2:3:4').detail, 'GUIDED:IDEA');
});
