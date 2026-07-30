import assert from 'assert';
import {
    describe, it,
} from 'node:test';
import { hasResolverFreeze } from '../packages/onsite-toolkit/resolver';

describe('onsite resolver availability', () => {
    it('treats an OI contest without lockAt as frozen for its full duration', () => {
        assert.equal(hasResolverFreeze('oi', null), true);
    });

    it('requires an explicit lockAt for other contest rules', () => {
        assert.equal(hasResolverFreeze('acm', null), false);
        assert.equal(hasResolverFreeze('ioi', null), false);
        assert.equal(hasResolverFreeze('acm', new Date()), true);
        assert.equal(hasResolverFreeze('ioi', new Date()), true);
    });
});
