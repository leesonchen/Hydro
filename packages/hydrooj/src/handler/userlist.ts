import { apply as applyUserlist } from '../builtin/userlist';
import type { Context } from '../context';

export async function apply(ctx: Context) {
    await applyUserlist(ctx, { banMode: 'allPrivilege' });
}
