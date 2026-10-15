import type { HandlerCommon } from './server';

export default function serializer(ignoreSerializeFunction = false, h?: HandlerCommon) {
    const publicDictionaries = new WeakSet(
        (h?.response?.publicDictionaries || []).filter((value): value is object => (
            value !== null && (typeof value === 'object' || typeof value === 'function')
        )),
    );
    return function serialize(this: object, k: string, v: any) {
        if ((k.startsWith('_') && k !== '_id' && !publicDictionaries.has(this)) || k === 'participantUids') return undefined;
        if (typeof v === 'bigint') return `BigInt::${v.toString()}`;
        if (!ignoreSerializeFunction && v && typeof v === 'object'
            && 'serialize' in v && typeof v.serialize === 'function') return v.serialize(h);
        return v;
    };
}
