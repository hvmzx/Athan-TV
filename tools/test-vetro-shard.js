/*
 * Local tests for the Athan TV Alarm Shard. No TV or network needed.
 * Usage: node tools/test-vetro-shard.js
 */
"use strict";

const assert = require("assert");
const EventEmitter = require("events");
const path = require("path");

const create = require(path.join(__dirname, "..", "vetro-shard", "athan-alarm", "index.js"));
const internals = create._internals;

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log("PASS " + name);
    } catch (error) {
        failed++;
        console.log("FAIL " + name + ": " + (error && error.message || error));
    }
}

function mockCtx(store, commands) {
    return {
        id: "athan-alarm",
        dir: ".",
        config: {
            get: function () { return store; },
            set: function (value) { store = value; }
        },
        execute: function (cmd, timeout) {
            commands.push({ cmd: cmd, timeout: timeout });
            return Promise.resolve();
        }
    };
}

function fakeRes() {
    return {
        headersSent: false,
        code: 0,
        body: null,
        writeHead: function (code, headers) { this.code = code; this.headers = headers; },
        end: function (body) { this.body = body; }
    };
}

function fakeReq(data) {
    const req = new EventEmitter();
    req.method = "POST";
    process.nextTick(function () {
        if (data !== null) {
            req.emit("data", Buffer.from(JSON.stringify(data)));
        }
        req.emit("end");
    });
    return req;
}

const CONF_HTML = '<html><script>window.confData = ' +
    JSON.stringify({
        timezone: "Europe/Paris",
        times: ["06:30", "12:00", "14:00", "17:00", "18:30"],
        shuruq: "08:00",
        calendar: [],
        iqamaCalendar: []
    }) + ';</script></html>';

test("parseConfData extracts the object", function () {
    const conf = internals.parseConfData(CONF_HTML);
    assert.strictEqual(conf.timezone, "Europe/Paris");
    assert.strictEqual(conf.times[0], "06:30");
});

test("buildEvents converts local times to UTC with a fixed offset", function () {
    const conf = internals.parseConfData(CONF_HTML);
    const now = Date.parse("2026-11-24T10:00:00.000Z");
    const events = internals.buildEvents(conf, now, "UTC", 60);
    const fajr = events.filter(function (e) { return e.prayer === "fajr" && e.at > now - 86400000 && e.at <= now; }).pop();
    assert(fajr, "expected a fajr event");
    assert.strictEqual(fajr.time, "06:30");
    assert.strictEqual(fajr.atUtc, "2026-11-24T05:30:00.000Z");
});

test("buildEvents uses Intl timezone when available", function () {
    const conf = internals.parseConfData(CONF_HTML);
    if (!internals.validTimezone("Europe/Paris")) {
        return; // older Node without full ICU: fixed offset is the supported fallback
    }
    const now = Date.parse("2026-11-24T10:00:00.000Z");
    const events = internals.buildEvents(conf, now, "Europe/Paris", null);
    const fajr = events.filter(function (e) { return e.prayer === "fajr" && e.at > now - 86400000 && e.at <= now; }).pop();
    assert.strictEqual(fajr.atUtc, "2026-11-24T05:30:00.000Z");
});

test("tick fires once at adhan and launches the widget", function () {
    const now = Date.now();
    const store = {
        slug: "assalam-argenteuil",
        appId: "AthanTizen.AthanTizen",
        enabled: true,
        pollSeconds: 30,
        schedule: {
            at: now,
            slug: "assalam-argenteuil",
            events: [{ key: "dohr@x", prayer: "dohr", label: "Dhuhr", time: "12:00", at: now - 1000, atUtc: "x" }]
        }
    };
    const commands = [];
    const inst = create(mockCtx(store, commands));
    inst._test.load();
    inst._test.tick();
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(commands[0].cmd, "/usr/bin/app_launcher -s AthanTizen.AthanTizen");
    inst._test.tick();
    assert.strictEqual(commands.length, 1, "must not fire twice");
});

test("tick ignores a prayer that started over 90 seconds ago", function () {
    const now = Date.now();
    const store = {
        slug: "assalam-argenteuil", enabled: true, pollSeconds: 30,
        schedule: { at: now, slug: "assalam-argenteuil", events: [
            { key: "old@x", prayer: "asr", label: "Asr", time: "14:00", at: now - 120000, atUtc: "x" }
        ] }
    };
    const commands = [];
    const inst = create(mockCtx(store, commands));
    inst._test.load();
    inst._test.tick();
    assert.strictEqual(commands.length, 0);
});

test("ui route serves a settings page", function () {
    const inst = create(mockCtx({ slug: "assalam-argenteuil" }, []));
    const res = fakeRes();
    assert.strictEqual(inst.route({}, res, "ui"), true);
    assert(res.body.indexOf("Mosque slug") > 0);
    assert(res.body.indexOf("mawaqit.net") > 0);
    assert(res.body.indexOf("Test launch") > 0);
});

function asyncTest(name, fn) {
    setTimeout(function () {
        fn(function (error) {
            if (error) {
                failed++;
                console.log("FAIL " + name + ": " + (error && error.message || error));
            } else {
                passed++;
                console.log("PASS " + name);
            }
        });
    }, 10);
}

asyncTest("config route accepts a POST and stores the slug", function (done) {
    const store = { slug: "" };
    const inst = create(mockCtx(store, []));
    const res = fakeRes();
    assert.strictEqual(inst.route(fakeReq({ slug: "assalam-argenteuil", appId: "AthanTizen.AthanTizen", enabled: true, pollSeconds: 45 }), res, "config"), true);
    setTimeout(function () {
        let error = null;
        try {
            assert.strictEqual(inst._test.settings().slug, "assalam-argenteuil");
            assert.strictEqual(inst._test.settings().pollSeconds, 45);
        } catch (e) {
            error = e;
        }
        inst.stop();
        done(error);
    }, 30);
});

asyncTest("schedule route accepts pushed UTC events", function (done) {
    const inst = create(mockCtx({}, []));
    const res = fakeRes();
    assert.strictEqual(inst.route(fakeReq({ events: [
        { key: "fajr@x", prayer: "fajr", label: "Fajr", time: "06:00", atUtc: "2026-11-25T05:00:00.000Z" }
    ] }), res, "schedule"), true);
    setTimeout(function () {
        let error = null;
        try {
            assert.strictEqual(inst._test.settings().schedule.events.length, 1);
            assert.strictEqual(inst._test.settings().schedule.pushed, true);
        } catch (e) {
            error = e;
        }
        done(error);
    }, 30);
});

setTimeout(function () {
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
}, 250);
