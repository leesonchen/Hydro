import { hostname } from 'os';
import cac from 'cac';
import {
    Abortable, BSON, ChangeStreamOptions, Filter, FindOneAndUpdateOptions, ObjectId,
} from 'mongodb';
import { nanoid } from 'nanoid';
import { sleep } from '@hydrooj/utils/lib/utils';
import { Context } from '../context';
import { EventDoc, Task } from '../interface';
import { Logger } from '../logger';
import bus from '../service/bus';
import db from '../service/db';

const logger = new Logger('model/task');
const coll = db.collection('task');
const collEvent = db.collection('event');
const argv = cac().parse();
const EVENT_SHUTDOWN_TIMEOUT_MS = 5000;

async function getFirst(query: Filter<Task>) {
    if (process.env.CI) return null;
    try {
        const q = { ...query };
        const res = await coll.findOneAndDelete(q, { sort: { priority: -1 } });
        if (res) {
            logger.debug('%o', res);
            return res;
        }
        return null;
    } catch (e) {
        // Usually caused by the database being down
        // Should recover once it is back
        logger.error(e);
        return null;
    }
}

export class Consumer {
    consuming: boolean;
    processing: Set<Task> = new Set();
    running?: any;
    notify: (res?: any) => void;

    constructor(public filter: any, public func: (t: Task) => Promise<void>, public destroyOnError = true, private concurrency = 1) {
        this.consuming = true;
        this.consume();
        bus.on('app/exit', this.destroy);
    }

    async consume() {
        while (this.consuming) {
            try {
                if (this.processing.size >= this.concurrency) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => {
                        this.notify = resolve;
                    });
                    continue;
                }
                const res = await getFirst(this.filter); // eslint-disable-line no-await-in-loop
                if (!res) {
                    // eslint-disable-next-line no-await-in-loop
                    await Promise.race([
                        new Promise((resolve) => { this.notify = resolve; }),
                        sleep(1000 / (this.concurrency - this.processing.size)),
                    ]);
                    continue;
                }
                this.processing.add(res);
                this.func(res)
                    .catch((err) => {
                        logger.error(err);
                        if (this.destroyOnError) this.destroy();
                    })
                    .finally(() => {
                        this.processing.delete(res);
                        this.notify?.();
                    });
            } catch (err) {
                logger.error(err);
                if (this.destroyOnError) this.destroy();
            }
        }
    }

    async destroy() {
        this.consuming = false;
        this.notify?.();
    }

    setConcurrency(concurrency: number) {
        this.concurrency = concurrency;
        this.notify?.();
    }

    setQuery(query: string) {
        this.filter = query;
        this.notify?.();
    }
}

class TaskModel {
    static coll = coll;

    static async add(task: Partial<Task> & { type: string }) {
        const t: Task = {
            ...task,
            priority: task.priority ?? 0,
            _id: new ObjectId(),
        };
        const res = await coll.insertOne(t);
        return res.insertedId;
    }

    static async addMany(tasks: Task[]) {
        const res = await coll.insertMany(tasks);
        return res.insertedIds;
    }

    static get(_id: ObjectId) {
        return coll.findOne({ _id });
    }

    static count(query: Filter<Task>) {
        return coll.countDocuments(query);
    }

    static del(_id: ObjectId) {
        return coll.deleteOne({ _id });
    }

    static deleteMany(query: Filter<Task>) {
        return coll.deleteMany(query);
    }

    static getFirst = getFirst;

    static consume(query: any, cb: (t: Task) => Promise<void>, destroyOnError = true, concurrency = 1) {
        return new Consumer(query, cb, destroyOnError, concurrency);
    }
}

const id = process.env.exec_mode === 'cluster_mode' ? hostname() : nanoid();

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => coll.deleteMany({ domainId }));
    ctx.on('bus/broadcast', (event, payload, trace) => {
        collEvent.insertOne({
            ack: [id],
            event,
            payload: BSON.EJSON.stringify(payload),
            expire: new Date(Date.now() + 10000),
            trace,
        });
    });

    if (process.env.NODE_APP_INSTANCE !== '0') return;
    const controller = new AbortController();
    // The driver propagates Abortable options through these operations at runtime.
    const streamOptions: ChangeStreamOptions & Abortable = { signal: controller.signal };
    const queryOptions: FindOneAndUpdateOptions & Abortable = { signal: controller.signal };
    const stream = collEvent.watch([], streamOptions);
    let running = true;
    let forced = false;
    let polling: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let wakeUp: (() => void) | undefined;
    const activeEvents = new Set<Promise<void>>();
    const wait = (ms: number) => new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => {
            clearTimeout(timer);
            wakeUp = undefined;
            resolve();
        };
        timer = setTimeout(finish, ms);
        wakeUp = finish;
        if (!running) finish();
    });
    const stop = () => {
        if (stopping) return stopping;
        running = false;
        wakeUp?.();
        const drained = Promise.allSettled([
            Promise.resolve().then(() => stream.close()), polling, ...activeEvents,
        ]).then((results) => {
            for (const result of results) if (result.status === 'rejected') logger.error(result.reason);
        });
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(() => {
                forced = true;
                controller.abort();
                logger.warn('Timed out waiting for event processing to stop.');
                resolve();
            }, EVENT_SHUTDOWN_TIMEOUT_MS);
        });
        stopping = Promise.race([drained, deadline]).finally(() => clearTimeout(timer));
        return stopping;
    };
    ctx.on('app/exit', stop);
    ctx.effect(() => stop);
    const handleEvent = async (doc: EventDoc) => {
        process.send?.({ type: 'hydro:broadcast', data: doc });
        const payload = BSON.EJSON.parse(doc.payload);
        await (bus.parallel as any)(doc.event, ...payload);
    };
    stream.on('change', (change) => {
        if (!running || change.operationType !== 'insert') return;
        if (change.fullDocument.ack.includes(id)) return;
        const task = handleEvent(change.fullDocument).catch((error) => logger.error(error));
        activeEvents.add(task);
        void task.finally(() => activeEvents.delete(task));
    });
    const poll = async () => {
        // Shutdown and disposal callbacks clear this flag.
        // eslint-disable-next-line no-unmodified-loop-condition
        while (running) {
            let res;
            try {
                // eslint-disable-next-line no-await-in-loop
                res = await collEvent.findOneAndUpdate(
                    { expire: { $gt: new Date() }, ack: { $nin: [id] } },
                    { $push: { ack: id } },
                    queryOptions,
                );
            } catch (e) {
                if (!running) break;
                logger.error(e);
                // eslint-disable-next-line no-await-in-loop
                await wait(50);
                continue;
            }
            if (forced) break;
            if (argv.options.showEvent) logger.info('Event: %o', res);
            // Drain a claimed event during a normal stop before its resources are disposed.
            // eslint-disable-next-line no-await-in-loop
            await (res ? handleEvent(res).catch((error) => logger.error(error)) : wait(500));
        }
    };
    stream.on('error', () => {
        if (!running || polling) return;
        // The $changeStream stage is only supported on replica sets.
        logger.info('No replica set found.');
        polling = poll().catch((error) => logger.error(error));
    });
    await db.ensureIndexes(collEvent, { name: 'expire', key: { expire: 1 }, expireAfterSeconds: 0 });
    await db.ensureIndexes(coll, { name: 'task', key: { type: 1, subType: 1, priority: -1 } });
}

export default TaskModel;
global.Hydro.model.task = TaskModel;
