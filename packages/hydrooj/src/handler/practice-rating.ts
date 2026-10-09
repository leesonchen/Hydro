import { Context } from '../context';
import { BadRequestError, ForbiddenError } from '../error';
import { canManageFeedback, feedbackActivity } from '../lib/classroomFeedbackAccess';
import { RatingDatabase } from '../lib/practice-rating/adapter';
import { ActiveScope, COLLECTIONS, PracticeRatingStore } from '../lib/practice-rating/store';
import problem from '../model/problem';
import user from '../model/user';
import db from '../service/db';
import { Handler } from '../service/server';

export class PracticeRatingTrialHandler extends Handler {
    async get() {
        const scope = this.domain._id;
        const database = db as unknown as RatingDatabase;
        const config = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
        if (!config?.teacherTrial) throw new ForbiddenError();
        const activityType = this.request.path.startsWith('/course/') ? 'course' : 'homework';
        const { tdoc, roster } = await feedbackActivity(this, activityType, this.request.params.tid);
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
        if (handler.request.method !== 'get' || !tdoc || !['course', 'homework'].includes(tdoc.rule)) return;
        const database = db as unknown as RatingDatabase;
        const config = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: handler.domain._id });
        if (config?.teacherTrial && await canManageFeedback(handler, tdoc)) {
            handler.response.body.practiceRatingUrl = handler.url(`${tdoc.rule}_practice_rating`, { tid: tdoc.docId });
        }
    });
    ctx.Route('course_practice_rating', '/course/:tid/practice-rating', PracticeRatingTrialHandler);
    ctx.Route('homework_practice_rating', '/homework/:tid/practice-rating', PracticeRatingTrialHandler);
}
