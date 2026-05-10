import type { Context } from '../context';
import { apply as applyCourseManagement } from '../builtin/course-management';

export async function apply(ctx: Context) {
    await applyCourseManagement(ctx, { enable: false });
}
