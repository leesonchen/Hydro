import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { BadRequestError, ForbiddenError, NotFoundError } from '../error';
import type { Tdoc } from '../interface';
import { RatingDatabase } from '../lib/practice-rating/adapter';
import { ActiveScope, COLLECTIONS, PracticeRatingStore } from '../lib/practice-rating/store';
import { PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import problem from '../model/problem';
import user from '../model/user';
import db from '../service/db';
import { Handler } from '../service/server';

/** Trial ratings contain individual learning estimates, so domain teachers/managers are not eligible yet. */
function isPracticeRatingAdmin(handler: Handler) {
    return !!handler.user?._id && handler.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
        && handler.session?.uid === handler.user._id && !handler.session?.sudoUid;
}

/** Resolve only the activity's assigned students; independent of classroom-feedback feature switches. */
async function activityRoster(domainId: string, tdoc: Tdoc) {
    const assigned = tdoc.assign || [];
    const names = assigned.filter((g) => g !== 'teachers' && !/^\d+$/.test(g));
    const groups = names.length ? await user.listGroup(domainId, undefined, names) : [];
    const teachers = new Set([tdoc.owner, ...(tdoc.maintainer || []),
        ...groups.flatMap((g) => g.class ? g.teachers || [] : [])]);
    const students = [
        ...assigned.filter((g) => /^\d+$/.test(g)).map(Number),
        ...groups.flatMap((g) => g.class ? g.students || [] : g.uids || []),
    ];
    if (!assigned.length) {
        const statuses = await contest.getMultiStatus(domainId, {
            docId: tdoc.docId, $or: [{ attend: true }, { attend: { $gt: 0 } }],
        }).project({ uid: 1 }).toArray();
        students.push(...statuses.map((s) => s.uid));
    }
    return [...new Set(students)].filter((uid) => uid > 0 && !teachers.has(uid));
}

export class PracticeRatingTrialHandler extends Handler {
    async get() {
        // Authorization is checked on every request, before fetching student or model data.
        if (!isPracticeRatingAdmin(this)) throw new ForbiddenError();
        const scope = this.domain._id;
        const database = db as unknown as RatingDatabase;
        const config = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
        if (!config?.adminTrial) throw new ForbiddenError();
        const activityType = this.request.path.startsWith('/course/') ? 'course' : 'homework';
        const tid = this.request.params.tid;
        if (!/^[a-f\d]{24}$/.test(tid)) throw new BadRequestError('Invalid activity ID');
        const tdoc = await contest.get(scope, new ObjectId(tid));
        if (!tdoc || tdoc.domainId !== scope || tdoc.rule !== activityType) throw new NotFoundError('Activity not found');
        const roster = await activityRoster(scope, tdoc);
        const uid = !this.request.query.uid ? undefined : Number(this.request.query.uid);
        const pid = !this.request.query.pid ? undefined : Number(this.request.query.pid);
        if ((uid !== undefined && (!Number.isSafeInteger(uid) || uid <= 0))
            || (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0))) throw new BadRequestError('Invalid uid or pid');
        if ((uid !== undefined && !roster.includes(uid)) || (pid !== undefined && !tdoc.pids.includes(pid))) throw new ForbiddenError();
        const pdict = await problem.getList(scope, tdoc.pids, true, false, ['docId', 'title', 'owner', 'hidden']);
        const visible = tdoc.pids.filter((p) => pdict[p] && problem.canViewBy(pdict[p], this.user));
        if (pid !== undefined && !visible.includes(pid)) throw new ForbiddenError();
        const udict = await user.getListForRender(scope, roster, ['displayName']);
        const report = await new PracticeRatingStore(database).read(scope, uid, pid);
        this.response.addHeader('Cache-Control', 'no-store');
        this.response.body = { report, uid, pid, title: tdoc.title,
            students: roster.filter((id) => udict[id]).map((id) => ({ uid: id, name: udict[id].displayName || udict[id].uname })),
            problems: visible.map((id) => ({ pid: id, title: pdict[id].title })),
            backUrl: this.url(activityType === 'course' ? 'course_detail' : 'homework_detail', { tid: tdoc.docId }) };
        this.response.template = 'practice_rating_trial.html';
    }
}

export function apply(ctx: Context) {
    ctx.on('handler/after', async (handler) => {
        const tdoc = handler.response.body?.tdoc;
        if (handler.request.method !== 'get' || !tdoc || !['course', 'homework'].includes(tdoc.rule)
            || !isPracticeRatingAdmin(handler) || tdoc.domainId !== handler.domain._id) return;
        const database = db as unknown as RatingDatabase;
        const config = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: handler.domain._id });
        if (config?.adminTrial) {
            handler.response.body.practiceRatingUrl = handler.url(`${tdoc.rule}_practice_rating`, { tid: tdoc.docId });
        }
    });
    ctx.Route('course_practice_rating', '/course/:tid/practice-rating', PracticeRatingTrialHandler);
    ctx.Route('homework_practice_rating', '/homework/:tid/practice-rating', PracticeRatingTrialHandler);
}
