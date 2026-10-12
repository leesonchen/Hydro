import * as Zip from '@zip.js/zip.js';
import _AdmZip from 'adm-zip';
import _ from 'lodash';
import { ObjectId as ObjectID } from 'mongodb';
import Schema from 'schemastery';
import superagent from 'superagent';
import proxy from 'superagent-proxy';
import { Context } from './context';

// The proxy package can resolve a separate @types/superagent installation.
// Declare the method on the client Hydro exports and patches at runtime.
declare module 'superagent' {
    interface Request {
        proxy(url: string): this;
    }
}

proxy(superagent as unknown as Parameters<typeof proxy>[0]);

export * from './interface';
export * from './typeutils';
export * from './utils';
export { WebSocket, WebSocketServer } from '@hydrooj/framework';
export { Filter, ObjectId } from 'mongodb';
export {
    _, ObjectID, Schema, superagent, Zip,
};
/** @deprecated Use ZipReader/ZipWriter instead */
export const AdmZip = _AdmZip;
export const definePlugin = <T = never>(args: {
    inject?: keyof Context[] | Record<keyof Context, any>;
    apply: (ctx: Context, config: T) => Promise<void> | void;
    schema?: Schema<T>;
    name?: string;
    Config?: Schema<T>;
}) => args;
