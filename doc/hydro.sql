/*
 Navicat Premium Data Transfer

 Source Server         : localdb-wsl
 Source Server Type    : MongoDB
 Source Server Version : 70011
 Source Host           : localhost:27017
 Source Schema         : hydro

 Target Server Type    : MongoDB
 Target Server Version : 70011
 File Encoding         : 65001

 Date: 16/07/2025 17:29:14
*/


// ----------------------------
// Collection structure for blacklist
// ----------------------------
db.getCollection("blacklist").drop();
db.createCollection("blacklist");
db.getCollection("blacklist").createIndex({
    expireAt: NumberInt("-1")
}, {
    name: "expire",
    background: true
});

// ----------------------------
// Collection structure for document
// ----------------------------
db.getCollection("document").drop();
db.createCollection("document");
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    docId: NumberInt("1")
}, {
    name: "basic",
    background: true,
    unique: true
});
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    owner: NumberInt("1"),
    docId: NumberInt("-1")
}, {
    name: "owner",
    background: true
});
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    "$**": "text"
}, {
    name: "search",
    background: true,
    sparse: true,
    weights: {
        search: NumberInt("1"),
        title: NumberInt("1")
    },
    "default_language": "english",
    "language_override": "language",
    textIndexVersion: NumberInt("3")
});
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    sort: NumberInt("1"),
    docId: NumberInt("1")
}, {
    name: "sort",
    background: true
});
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    parentType: NumberInt("1"),
    parentId: NumberInt("1"),
    vote: NumberInt("-1"),
    docId: NumberInt("-1")
}, {
    name: "solution",
    background: true,
    sparse: true
});
db.getCollection("document").createIndex({
    docType: NumberInt("1"),
    domainId: NumberInt("1"),
    hidden: NumberInt("1"),
    pin: NumberInt("-1"),
    docId: NumberInt("-1")
}, {
    name: "discussionSort",
    background: true,
    partialFilterExpression: {
        docType: { }
    }
});
db.getCollection("document").createIndex({
    docType: NumberInt("1"),
    domainId: NumberInt("1"),
    hidden: NumberInt("1"),
    parentType: NumberInt("1"),
    parentId: NumberInt("1"),
    pin: NumberInt("-1"),
    docId: NumberInt("-1")
}, {
    name: "discussionNodeSort",
    background: true,
    sparse: true
});
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    hidden: NumberInt("1"),
    docId: NumberInt("-1")
}, {
    name: "hiddenDoc",
    background: true,
    sparse: true
});
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    pids: NumberInt("1")
}, {
    name: "contest",
    background: true,
    sparse: true
});
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    rule: NumberInt("1"),
    docId: NumberInt("-1")
}, {
    name: "contestRule",
    background: true,
    sparse: true
});
db.getCollection("document").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    "dag.pids": NumberInt("1")
}, {
    name: "training",
    background: true,
    sparse: true
});

// ----------------------------
// Collection structure for document.status
// ----------------------------
db.getCollection("document.status").drop();
db.createCollection("document.status");
db.getCollection("document.status").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    docId: NumberInt("1"),
    uid: NumberInt("1")
}, {
    name: "basic",
    background: true,
    unique: true
});
db.getCollection("document.status").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    docId: NumberInt("1"),
    status: NumberInt("1"),
    rid: NumberInt("1"),
    rp: NumberInt("1")
}, {
    name: "rp",
    background: true,
    sparse: true
});
db.getCollection("document.status").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    docId: NumberInt("1"),
    score: NumberInt("-1")
}, {
    name: "contestRuleOI",
    background: true,
    sparse: true
});
db.getCollection("document.status").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    docId: NumberInt("1"),
    accept: NumberInt("-1"),
    time: NumberInt("1")
}, {
    name: "contestRuleACM",
    background: true,
    sparse: true
});
db.getCollection("document.status").createIndex({
    domainId: NumberInt("1"),
    docType: NumberInt("1"),
    uid: NumberInt("1"),
    enroll: NumberInt("1"),
    docId: NumberInt("1")
}, {
    name: "training",
    background: true,
    sparse: true
});

// ----------------------------
// Collection structure for domain
// ----------------------------
db.getCollection("domain").drop();
db.createCollection("domain");
db.getCollection("domain").createIndex({
    lower: NumberInt("1")
}, {
    name: "lower",
    background: true,
    unique: true
});

// ----------------------------
// Collection structure for domain.user
// ----------------------------
db.getCollection("domain.user").drop();
db.createCollection("domain.user");
db.getCollection("domain.user").createIndex({
    domainId: NumberInt("1"),
    uid: NumberInt("1")
}, {
    name: "uid",
    background: true,
    unique: true
});
db.getCollection("domain.user").createIndex({
    domainId: NumberInt("1"),
    rp: NumberInt("-1"),
    uid: NumberInt("1")
}, {
    name: "rp",
    background: true,
    sparse: true
});

// ----------------------------
// Collection structure for event
// ----------------------------
db.getCollection("event").drop();
db.createCollection("event");
db.getCollection("event").createIndex({
    expire: NumberInt("1")
}, {
    name: "expire",
    background: true
});

// ----------------------------
// Collection structure for message
// ----------------------------
db.getCollection("message").drop();
db.createCollection("message");
db.getCollection("message").createIndex({
    to: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "to",
    background: true
});
db.getCollection("message").createIndex({
    from: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "from",
    background: true
});

// ----------------------------
// Collection structure for oauth
// ----------------------------
db.getCollection("oauth").drop();
db.createCollection("oauth");
db.getCollection("oauth").createIndex({
    uid: NumberInt("1"),
    platform: NumberInt("1")
}, {
    name: "uid_platform",
    background: true
});

// ----------------------------
// Collection structure for opcount
// ----------------------------
db.getCollection("opcount").drop();
db.createCollection("opcount");
db.getCollection("opcount").createIndex({
    expireAt: NumberInt("-1")
}, {
    name: "expire",
    background: true
});
db.getCollection("opcount").createIndex({
    op: NumberInt("1"),
    ident: NumberInt("1"),
    expireAt: NumberInt("1")
}, {
    name: "unique",
    background: true,
    unique: true
});

// ----------------------------
// Collection structure for record
// ----------------------------
db.getCollection("record").drop();
db.createCollection("record");
db.getCollection("record").createIndex({
    domainId: NumberInt("1"),
    pid: NumberInt("1")
}, {
    name: "delete",
    background: true
});
db.getCollection("record").createIndex({
    domainId: NumberInt("1"),
    contest: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "basic",
    background: true
});
db.getCollection("record").createIndex({
    domainId: NumberInt("1"),
    contest: NumberInt("1"),
    uid: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "withUser",
    background: true
});
db.getCollection("record").createIndex({
    domainId: NumberInt("1"),
    contest: NumberInt("1"),
    pid: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "withProblem",
    background: true
});
db.getCollection("record").createIndex({
    domainId: NumberInt("1"),
    contest: NumberInt("1"),
    pid: NumberInt("1"),
    uid: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "withUserAndProblem",
    background: true
});
db.getCollection("record").createIndex({
    domainId: NumberInt("1"),
    contest: NumberInt("1"),
    status: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "withStatus",
    background: true
});

// ----------------------------
// Collection structure for record.history
// ----------------------------
db.getCollection("record.history").drop();
db.createCollection("record.history");
db.getCollection("record.history").createIndex({
    rid: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "basic",
    background: true
});

// ----------------------------
// Collection structure for record.stat
// ----------------------------
db.getCollection("record.stat").drop();
db.createCollection("record.stat");
db.getCollection("record.stat").createIndex({
    domainId: NumberInt("1"),
    pid: NumberInt("1"),
    uid: NumberInt("1"),
    _id: NumberInt("-1")
}, {
    name: "basic",
    background: true
});
db.getCollection("record.stat").createIndex({
    domainId: NumberInt("1"),
    pid: NumberInt("1"),
    uid: NumberInt("1"),
    time: NumberInt("1")
}, {
    name: "time",
    background: true
});
db.getCollection("record.stat").createIndex({
    domainId: NumberInt("1"),
    pid: NumberInt("1"),
    uid: NumberInt("1"),
    memory: NumberInt("1")
}, {
    name: "memory",
    background: true
});
db.getCollection("record.stat").createIndex({
    domainId: NumberInt("1"),
    pid: NumberInt("1"),
    uid: NumberInt("1"),
    length: NumberInt("1")
}, {
    name: "length",
    background: true
});

// ----------------------------
// Collection structure for schedule
// ----------------------------
db.getCollection("schedule").drop();
db.createCollection("schedule");
db.getCollection("schedule").createIndex({
    type: NumberInt("1"),
    subType: NumberInt("1"),
    executeAfter: NumberInt("-1")
}, {
    name: "schedule",
    background: true
});

// ----------------------------
// Collection structure for status
// ----------------------------
db.getCollection("status").drop();
db.createCollection("status");
db.getCollection("status").createIndex({
    updateAt: NumberInt("1")
}, {
    name: "expire",
    background: true,
    expireAfterSeconds: NumberInt("62400")
});

// ----------------------------
// Collection structure for storage
// ----------------------------
db.getCollection("storage").drop();
db.createCollection("storage");
db.getCollection("storage").createIndex({
    path: NumberInt("1")
}, {
    name: "path",
    background: true
});
db.getCollection("storage").createIndex({
    path: NumberInt("1"),
    autoDelete: NumberInt("1")
}, {
    name: "autoDelete",
    background: true,
    sparse: true
});
db.getCollection("storage").createIndex({
    link: NumberInt("1")
}, {
    name: "link",
    background: true,
    sparse: true
});

// ----------------------------
// Collection structure for system
// ----------------------------
db.getCollection("system").drop();
db.createCollection("system");

// ----------------------------
// Collection structure for task
// ----------------------------
db.getCollection("task").drop();
db.createCollection("task");
db.getCollection("task").createIndex({
    type: NumberInt("1"),
    subType: NumberInt("1"),
    priority: NumberInt("-1")
}, {
    name: "task",
    background: true
});

// ----------------------------
// Collection structure for token
// ----------------------------
db.getCollection("token").drop();
db.createCollection("token");
db.getCollection("token").createIndex({
    uid: NumberInt("1"),
    tokenType: NumberInt("1"),
    updateAt: NumberInt("-1")
}, {
    name: "basic",
    background: true,
    sparse: true
});
db.getCollection("token").createIndex({
    expireAt: NumberInt("-1")
}, {
    name: "expire",
    background: true
});

// ----------------------------
// Collection structure for user
// ----------------------------
db.getCollection("user").drop();
db.createCollection("user");
db.getCollection("user").createIndex({
    unameLower: NumberInt("1")
}, {
    name: "uname",
    background: true,
    unique: true
});
db.getCollection("user").createIndex({
    mailLower: NumberInt("1")
}, {
    name: "mail",
    background: true,
    unique: true
});

// ----------------------------
// Collection structure for user.group
// ----------------------------
db.getCollection("user.group").drop();
db.createCollection("user.group");
db.getCollection("user.group").createIndex({
    domainId: NumberInt("1"),
    name: NumberInt("1")
}, {
    name: "name",
    background: true,
    unique: true
});
db.getCollection("user.group").createIndex({
    domainId: NumberInt("1"),
    uids: NumberInt("1")
}, {
    name: "uid",
    background: true
});

// ----------------------------
// Collection structure for vuser
// ----------------------------
db.getCollection("vuser").drop();
db.createCollection("vuser");
db.getCollection("vuser").createIndex({
    unameLower: NumberInt("1")
}, {
    name: "uname",
    background: true,
    unique: true
});
db.getCollection("vuser").createIndex({
    mailLower: NumberInt("1")
}, {
    name: "mail",
    background: true,
    unique: true
});
