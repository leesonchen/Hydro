import { apply as applyCourseManagement } from '../builtin/course-management';
import type { Context } from '../context';

export async function apply(ctx: Context) {
    await applyCourseManagement(ctx, { enable: false });
}
