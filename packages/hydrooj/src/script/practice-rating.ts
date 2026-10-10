/* eslint-disable no-await-in-loop */
import Schema from 'schemastery';
import { Context } from '../context';
import { RatingDatabase } from '../lib/practice-rating/adapter';
import { runPracticeRating } from '../lib/practice-rating/runner';
import { ActiveScope, checksum, COLLECTIONS, PracticeRatingStore } from '../lib/practice-rating/store';
import { evaluatePracticePredictions, freezePracticePredictions, MAX_PREDICTION_PAIRS } from '../lib/practice-rating/validation';
import { Logger } from '../logger';
import db from '../service/db';

const logger = new Logger('practice-rating');
const database = db as unknown as RatingDatabase;
const domainId = Schema.string().description('One domain; scores are not comparable across domains').required();
const excludedUids = Schema.array(Schema.number().min(1).step(1)).description('Explicitly identified test/service accounts; omitted leaves configuration unchanged');

export async function apply(ctx: Context) {
    ctx.addScript('practice-rating-run', 'Fit practice R/D (report only by default; writes use independent shadow collections)', Schema.object({
        domainId,
        asOf: Schema.number().min(0).step(1).description('UTC epoch milliseconds; absent means current cutoff'),
        excludedUids,
        write: Schema.boolean().default(false),
    }), async (options, report) => {
        report({ message: JSON.stringify(await runPracticeRating(database, { ...options, domainId: options.domainId })) });
        return true;
    });
    ctx.addScript('practice-rating-report', 'Read one active practice run; administrator only, no source evidence', Schema.object({
        domainId,
        uid: Schema.number().min(1).step(1),
        pid: Schema.number().min(1).step(1),
        revision: Schema.string().description('Absent means unknown historical revision'),
    }), async (options, report) => {
        const result = await new PracticeRatingStore(database).read(options.domainId, options.uid, options.pid, options.revision ?? null);
        report({ message: JSON.stringify(result) });
        return true;
    });
    ctx.addScript('practice-rating-configure', 'Update opt-in daily fits, administrator-only trial or exclusions (only supplied fields change)', Schema.object({
        domainId,
        enabled: Schema.boolean().description('Opt in/out of the daily shadow run'),
        adminTrial: Schema.boolean().description('Opt in/out of system-administrator-only trial pages'),
        excludedUids,
    }), async (options, report) => {
        if (!await database.collection('domain').findOne({ _id: options.domainId as any }, { projection: { _id: 1 } })) {
            throw new Error('Unknown domain');
        }
        const changes: Partial<ActiveScope> = {};
        if (options.enabled !== undefined) changes.enabled = options.enabled;
        if (options.adminTrial !== undefined) changes.adminTrial = options.adminTrial;
        if (options.excludedUids !== undefined) {
            const effective = [...new Set<number>(options.excludedUids)].sort((a, b) => a - b);
            changes.excludedUids = effective;
            changes.exclusionConfigVersion = checksum(effective);
        }
        if (!Object.keys(changes).length) throw new Error('Provide enabled, adminTrial or excludedUids');
        await database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: options.domainId }, {
            $set: changes,
        }, { upsert: true });
        report({ message: `Practice rating settings updated for ${options.domainId}: ${Object.keys(changes).join(', ')}` });
        return true;
    });
    ctx.addScript('practice-rating-freeze', 'Freeze an explicit future cohort before its first eligible attempts', Schema.object({
        domainId,
        pairs: Schema.array(Schema.object({ uid: Schema.number().min(1).step(1).required(),
            pid: Schema.number().min(1).step(1).required() })).min(1).max(MAX_PREDICTION_PAIRS).required(),
    }), async (options, report) => {
        const pairs = options.pairs.map((p) => ({ uid: p.uid, pid: p.pid }));
        report({ message: JSON.stringify(await freezePracticePredictions(database, options.domainId, pairs)) });
        return true;
    });
    ctx.addScript('practice-rating-evaluate', 'Read future 7-day completion calibration; never modifies frozen predictions', Schema.object({
        domainId,
        predictionId: Schema.string().required(),
        asOf: Schema.number().min(0).step(1),
    }), async (options, report) => {
        report({ message: JSON.stringify(await evaluatePracticePredictions(database, options.domainId, options.predictionId, options.asOf)) });
        return true;
    });
    ctx.on('task/daily', async () => {
        const scopes = await database.collection<ActiveScope>(COLLECTIONS.active).find({ enabled: true }).sort({ _id: 1 }).toArray();
        for (const scope of scopes) {
            try {
                const summary = await runPracticeRating(database, { domainId: scope._id, write: true });
                logger.info('Daily shadow run: %o', summary);
            } catch (error) {
                logger.error('Daily shadow fit failed for %s; previous active run preserved: %s', scope._id, error.message);
            }
        }
    });
}
