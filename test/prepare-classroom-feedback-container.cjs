// Compile pure source/tests into a temporary tree. Do not copy installed Hydro
// packages or profiles: the container run uses Node only, with no database.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const output = path.resolve(__dirname, '../.cache/feedback-container-tests');
const sources = [
    'packages/hydrooj/src/lib/classroomFeedback.ts',
    'packages/hydrooj/src/builtin/course-management/model/course.ts',
    'packages/hydrooj/src/builtin/course-management/model/structure.ts',
    'packages/ui-default/components/classroom-feedback-state.ts',
];
for (const relative of sources) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
}
for (const name of ['classroom-feedback.spec.js', 'classroom-feedback-state.spec.js', 'course-feedback-structure.spec.js']) {
    let content = fs.readFileSync(path.join(__dirname, name), 'utf8').replaceAll('\r\n', '\n');
    content = content.replace("const ts = require('typescript');\n", '');
    content = content.replace(/ts\.transpileModule\(fs\.readFileSync\(filename, 'utf8'\), \{[\s\S]*?\}\)\.outputText/g,
        "fs.readFileSync(filename, 'utf8')");
    if (content.includes('ts.transpileModule')) throw new Error('Unconverted test loader: ' + name);
    fs.mkdirSync(path.join(output, 'test'), { recursive: true });
    fs.writeFileSync(path.join(output, 'test', name), content);
}
console.log(output);
