import Schema from 'schemastery';
import { auditContestParticipation } from '../lib/contest-participation';

export const description = 'Read-only audit for contest team configuration and participant ownership';

type Report = (data: any) => void;

export async function run(_: Record<string, never>, report: Report) {
    const findings = await auditContestParticipation((finding) => {
        report({ message: JSON.stringify(finding) });
    });
    report({ message: `Contest team audit finished with ${findings.length} finding(s).` });
    if (findings.length) throw new Error(`Contest team audit failed with ${findings.length} finding(s).`);
    return true;
}

export const apply = (ctx) => ctx.addScript(
    'contest-team-audit',
    description,
    Schema.object({}),
    run,
);
