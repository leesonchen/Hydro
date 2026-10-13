import db from '../service/db';
import { PRIV } from '@hydrooj/common/permission';
import { ratingOverlay, RatingPointer, RatingPublicationStore } from './rating-publication-store';

export const publicRatingStore = new RatingPublicationStore(db);
const publicFields = ['ratingAlgorithm', 'ratingUpdatedAt', 'rating', 'ratedEvents', 'ratingAchievement', 'ratingTier', 'ratingTierName'];

/** Clone cached user objects: public score selection must never mutate permission/profile caches. */
export async function projectUserRatings<T extends { _id: number }>(domainId: string, users: T[], pointer?: RatingPointer | null): Promise<T[]> {
    const { active, rows } = await publicRatingStore.rows(domainId, users.map((user) => user._id), pointer);
    if (!active) return users;
    const byUid = new Map(rows.map((row) => [row.uid, row]));
    const live = await db.collection('user').find({ _id: { $in: users.map((user) => user._id) },
        priv: { $bitsAllSet: PRIV.PRIV_USER_PROFILE } }, { projection: { _id: 1 } }).toArray();
    const visible = new Set(live.map((user) => user._id));
    return users.map((user: any) => {
        const row = visible.has(user._id) ? byUid.get(user._id) : undefined;
        const result = Object.assign(Object.create(Object.getPrototypeOf(user)), user, ratingOverlay(active, row));
        if (user._publicFields) result._publicFields = [...new Set([...user._publicFields, ...publicFields])];
        return result;
    });
}

export async function projectUserRating<T extends { _id: number }>(domainId: string, user: T, pointer?: RatingPointer | null): Promise<T> {
    return (await projectUserRatings(domainId, [user], pointer))[0];
}
