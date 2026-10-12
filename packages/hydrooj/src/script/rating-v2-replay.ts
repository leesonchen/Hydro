import Schema from 'schemastery';
import { runShadowReplay } from '../lib/rating-v2/shadow-replay';
import db from '../service/db';

export const description = 'Run the rating-v2 shadow replay (default: report only, no writes)';

export async function run(options: any, report: (message: any) => void) {
    const summary = await runShadowReplay(db, options, (m) => report(
        typeof m === 'string' ? { message: m } : m,
    ));
    report({ message: `Shadow summary: ${JSON.stringify(summary)}` });
    return true;
}

const numberOpt = (desc: string, def: number) => Schema.number().min(0).description(desc).default(def);

export const apply = (ctx) => ctx.addScript(
    'rating-v2-replay',
    description,
    Schema.object({
        eligibilityMode: Schema.union(['trial', 'certified']).default('trial')
            .description('Trial preserves legacy sampling; certified requires frozen policy and submission facts'),
        rules: Schema.array(String).description('Contest rules considered').default(['acm', 'oi', 'ioi', 'strictioi']),
        minParticipants: numberOpt('Minimum distinct in-window participants; rating also requires at least two', 1),
        includeDuration: Schema.boolean().description('Include personal-duration contests').default(true),
        includeAssign: Schema.boolean().description('Include contests assigned to courses').default(true),
        provisionalEvents: numberOpt('Rated events before a player leaves provisional status', 5),
        maxDelta: numberOpt('Soft saturation bound for per-contest rating change', 200),
        difficultyMinPriorEvents: numberOpt('Rated events before a player yields difficulty observations', 5),
        difficultyMinStudents: numberOpt('Distinct students required for a provisional difficulty', 20),
        difficultyMaxSe: numberOpt('Maximum conditional standard error for provisional difficulty', 150),
        priorMean: numberOpt('Initial ability prior mean', 1500),
        priorSd: numberOpt('Initial ability prior standard deviation', 600),
        refDomain: Schema.string().description('Domain used for old-vs-new comparison').default('cpptrain'),
        poolId: Schema.string().description('Rating pool id').default('default'),
        write: Schema.boolean().description('Write results to ratingv2_shadow collection').default(false),
    }),
    run,
);
