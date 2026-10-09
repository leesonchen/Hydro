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
const excludedUids = Schema.array(Schema.number().min(1).step(1)).description('Explicitly identified test/service accounts').default([]);

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
    ctx.addScript('practice-rating-configure', 'Explicitly enable/disable daily shadow fits for one domain', Schema.object({
        domainId,
        enabled: Schema.boolean().required(),
        teacherTrial: Schema.boolean().default(false).description('Enable authorized course/homework teachers to read practice estimates'),
        excludedUids,
    }), async (options, report) => {
        if (!await database.collection('domain').findOne({ _id: options.domainId as any }, { projection: { _id: 1 } })) {
            throw new Error('Unknown domain');
        }
        const effective = [...new Set<number>(options.excludedUids)].sort((a, b) => a - b);
        await database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: options.domainId }, {
            $set: { enabled: options.enabled, teacherTrial: options.teacherTrial,
                excludedUids: effective, exclusionConfigVersion: checksum(effective) },
        }, { upsert: true });
        report({ message: `Daily practice rating ${options.enabled ? 'enabled' : 'disabled'} for ${options.domainId}` });
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
