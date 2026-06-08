# URL Audit

Records Hydro HTTP handler visits into MongoDB for later user URL audits.

## Defaults

- Collection: `url.audit`
- Retention: 30 days
- Anonymous users: ignored
- Methods: `GET,POST,PUT,PATCH,DELETE`
- Static assets and common sensitive query keys are filtered by default.

## Enable locally

```bash
hydrooj addon add /absolute/path/to/packages/url-audit
```

Restart Hydro after enabling the addon.

## Query examples

```js
db.getCollection('url.audit').find({ uid: 123 }).sort({ time: -1 }).limit(50)
db.getCollection('url.audit').find({ domainId: 'system' }).sort({ time: -1 }).limit(50)
```

The management page is available at `/manage/url-audit` for users with system edit privilege.

## Cleanup

Each record stores `expireAt = time + retentionDays`. MongoDB removes expired records through the TTL index on `expireAt`; Hydro's Mongo service also runs an hourly fallback cleanup for TTL indexes.
