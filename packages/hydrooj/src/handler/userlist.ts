import type { Context } from '../context';
import { apply as applyUserlist } from '../builtin/userlist';

export async function apply(ctx: Context) {
    await applyUserlist(ctx, { banMode: 'allPrivilege' });
}
