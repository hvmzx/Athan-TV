'use strict';
/*
 * Athan TV Alarm - a Vetro Shard (API 1).
 *
 * Vetro's service is always running as root, unlike a Tizen web widget. This
 * Shard reads the selected mosque's confData from mawaqit.net, converts the
 * prayer times to absolute UTC, and at each adhan launches the Athan TV widget
 * with app_launcher. The widget then shows its full-screen overlay and plays
 * adhan.mp3. No Tizen background-support flag, PC or second audio stack needed.
 *
 * ES5 / Node 4.4 compatible. No sandbox: treat this code as root code.
 */

var https = require('https');
var http = require('http');
var urlUtil = require('url');

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 AthanTV-Alarm/0.1';
var BASE = 'https://mawaqit.net';
var PRAYERS = [
    ['fajr', 'Fajr'],
    ['dohr', 'Dhuhr'],
    ['asr', 'Asr'],
    ['maghreb', 'Maghrib'],
    ['icha', 'Isha']
];
var DEFAULTS = {
    slug: '',
    appId: 'AthanTizen.AthanTizen',
    enabled: true,
    pollSeconds: 30,
    refreshMinutes: 30,
    utcOffsetMinutes: null,
    lastFired: {},
    lastLaunch: '',
    lastError: '',
    schedule: null
};
var FETCH_TIMEOUT = 30000;
var LATE_WINDOW = 90 * 1000;

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function validTimezone(name) {
    if (!name || typeof Intl === 'undefined' || !Intl.DateTimeFormat) {
        return null;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: name }).format(new Date());
        return name;
    } catch (error) {
        return null;
    }
}

function zoneParts(date, tz, fixedMinutes) {
    if (fixedMinutes !== null && fixedMinutes !== undefined) {
        var shifted = new Date(date.getTime() + fixedMinutes * 60000);
        return {
            year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1,
            day: shifted.getUTCDate(), hour: shifted.getUTCHours(),
            minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds(),
            y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate()
        };
    }
    var options = {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    };
    var formatter = new Intl.DateTimeFormat('en-US', options);
    var parts;
    var map = {};
    var i;
    if (typeof formatter.formatToParts === 'function') {
        parts = formatter.formatToParts(date);
        for (i = 0; i < parts.length; i++) {
            map[parts[i].type] = parts[i].value;
        }
    } else {
        var match = /(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/
            .exec(formatter.format(date));
        if (!match) {
            throw new Error('timezone');
        }
        map.month = match[1];
        map.day = match[2];
        map.year = match[3];
        map.hour = match[4];
        map.minute = match[5];
        map.second = match[6] || '0';
    }
    var hour = parseInt(map.hour, 10);
    if (hour === 24) {
        hour = 0;
    }
    return {
        year: parseInt(map.year, 10), month: parseInt(map.month, 10),
        day: parseInt(map.day, 10), hour: hour,
        minute: parseInt(map.minute, 10), second: parseInt(map.second, 10),
        y: parseInt(map.year, 10), m: parseInt(map.month, 10), d: parseInt(map.day, 10)
    };
}

function zoneOffsetMs(epochMs, tz, fixedMinutes) {
    var p = zoneParts(new Date(epochMs), tz, fixedMinutes);
    var asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(epochMs / 1000) * 1000;
}

function zonedToUtc(y, m, d, h, min, tz, fixedMinutes) {
    var guess = Date.UTC(y, m - 1, d, h, min, 0);
    var first = guess - zoneOffsetMs(guess, tz, fixedMinutes);
    var second = guess - zoneOffsetMs(first, tz, fixedMinutes);
    return second;
}

function parseHm(value) {
    if (value === null || typeof value === 'undefined') {
        return null;
    }
    var match = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
    if (!match) {
        return null;
    }
    var h = parseInt(match[1], 10);
    var min = parseInt(match[2], 10);
    if (h > 23 || min > 59) {
        return null;
    }
    return { h: h, m: min };
}

function timesForDay(conf, y, m, d, today) {
    var calendar = conf.calendar;
    if (Array.isArray(calendar) && calendar.length >= 12) {
        var values = calendar[m - 1] && calendar[m - 1][String(d)];
        if (Array.isArray(values) && values.length >= 6) {
            return {
                fajr: values[0], shuruq: values[1], dohr: values[2],
                asr: values[3], maghreb: values[4], icha: values[5]
            };
        }
    }
    var isToday = today && today.y === y && today.m === m && today.d === d;
    if (isToday && Array.isArray(conf.times) && conf.times.length >= 5) {
        return {
            fajr: conf.times[0], shuruq: conf.shuruq || '',
            dohr: conf.times[1], asr: conf.times[2],
            maghreb: conf.times[3], icha: conf.times[4]
        };
    }
    return {};
}

function parseConfData(html) {
    var marker = /\bconfData\s*=\s*\{/.exec(html);
    if (!marker) {
        throw new Error('parse: confData not found');
    }
    var start = html.indexOf('{', marker.index);
    var depth = 0;
    var inString = false;
    var escaped = false;
    var i;
    for (i = start; i < html.length; i++) {
        var ch = html.charAt(i);
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return JSON.parse(html.slice(start, i + 1));
            }
        }
    }
    throw new Error('parse: unbalanced confData');
}

function buildEvents(conf, nowMs, tz, fixedMinutes) {
    var local = zoneParts(new Date(nowMs), tz, fixedMinutes);
    var base = Date.UTC(local.year, local.month - 1, local.day);
    var events = [];
    var offset;
    for (offset = -1; offset <= 2; offset++) {
        var date = new Date(base + offset * 86400000);
        var y = date.getUTCFullYear();
        var m = date.getUTCMonth() + 1;
        var d = date.getUTCDate();
        var times = timesForDay(conf, y, m, d, local);
        var i;
        for (i = 0; i < PRAYERS.length; i++) {
            var key = PRAYERS[i][0];
            var adhan = parseHm(times[key]);
            if (!adhan) {
                continue;
            }
            var ms = zonedToUtc(y, m, d, adhan.h, adhan.m, tz, fixedMinutes);
            events.push({
                key: key + '@' + new Date(ms).toISOString(),
                prayer: key,
                label: PRAYERS[i][1],
                time: pad2(adhan.h) + ':' + pad2(adhan.m),
                at: ms,
                atUtc: new Date(ms).toISOString()
            });
        }
    }
    events.sort(function (a, b) { return a.at - b.at; });
    return events;
}

function fetchText(target, timeoutMs, cb, depth) {
    var settled = false;
    var redirects = depth || 0;
    var parsed;
    try {
        parsed = urlUtil.parse(target);
    } catch (error) {
        cb(error);
        return;
    }
    var mod = parsed.protocol === 'http:' ? http : https;
    var options = {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.path || '/',
        method: 'GET',
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'Accept-Encoding': 'identity'
        }
    };
    var req;
    try {
        req = mod.request(options, function (res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (settled) {
                    return;
                }
                if (redirects >= 4) {
                    settled = true;
                    cb(new Error('too many redirects'));
                    return;
                }
                fetchText(urlUtil.resolve(target, res.headers.location), timeoutMs, cb, redirects + 1);
                return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                if (!settled) {
                    settled = true;
                    cb(new Error('HTTP ' + res.statusCode));
                }
                return;
            }
            var chunks = [];
            res.on('data', function (chunk) { chunks.push(chunk); });
            res.on('end', function () {
                if (settled) {
                    return;
                }
                settled = true;
                cb(null, Buffer.concat(chunks).toString('utf8'));
            });
            res.on('error', function (error) {
                if (!settled) {
                    settled = true;
                    cb(error);
                }
            });
        });
    } catch (error) {
        cb(error);
        return;
    }
    req.setTimeout(timeoutMs, function () {
        req.abort();
        if (!settled) {
            settled = true;
            cb(new Error('timeout'));
        }
    });
    req.on('error', function (error) {
        if (!settled) {
            settled = true;
            cb(error);
        }
    });
    req.end();
}

function readBody(req, cb) {
    var chunks = [];
    var size = 0;
    var done = false;
    req.on('data', function (chunk) {
        size += chunk.length;
        if (size > 65536) {
            if (!done) {
                done = true;
                cb(new Error('too large'));
            }
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', function () {
        if (!done) {
            done = true;
            cb(null, Buffer.concat(chunks).toString('utf8'));
        }
    });
    req.on('error', function (error) {
        if (!done) {
            done = true;
            cb(error);
        }
    });
}

function jsonResponse(res, value, status) {
    if (res.headersSent) {
        return;
    }
    res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}

function htmlResponse(res, html) {
    if (res.headersSent) {
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
}

function makeCreate(ctx) {
    var settings = {};
    var timer = null;
    var refreshing = false;
    var lastUiMessage = '';

    function load() {
        var saved;
        try {
            saved = ctx.config.get() || {};
        } catch (error) {
            saved = {};
        }
        var key;
        settings = {};
        for (key in DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
                settings[key] = Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : DEFAULTS[key];
            }
        }
        if (!settings.lastFired || typeof settings.lastFired !== 'object') {
            settings.lastFired = {};
        }
    }

    function save() {
        try {
            ctx.config.set(settings);
        } catch (error) {
            settings.lastError = 'config: ' + (error && error.message || error);
        }
    }

    function cleanSlug(value) {
        var slug = String(value || '').trim().toLowerCase();
        return /^[a-z0-9][a-z0-9-]{1,120}$/.test(slug) ? slug : '';
    }

    function cleanAppId(value) {
        var id = String(value || '').trim();
        return /^[A-Za-z0-9_.-]{1,120}$/.test(id) ? id : DEFAULTS.appId;
    }

    function effectiveZone(conf) {
        var zone = validTimezone(conf.timezone);
        var fixed = null;
        if (!zone) {
            fixed = settings.utcOffsetMinutes;
            if (typeof fixed !== 'number' || !isFinite(fixed)) {
                fixed = null;
            }
        }
        if (!zone && fixed === null) {
            throw new Error('timezone ' + (conf.timezone || '?') + ' unsupported: set utcOffsetMinutes');
        }
        return { zone: zone || 'UTC', fixed: fixed };
    }

    function refresh(force, cb) {
        var slug = cleanSlug(settings.slug);
        if (!slug) {
            settings.lastError = 'Set a mosque slug in the Shard settings';
            save();
            cb(new Error(settings.lastError));
            return;
        }
        if (refreshing && !force) {
            cb(null);
            return;
        }
        refreshing = true;
        var now = Date.now();
        var cached = settings.schedule;
        if (!force && cached && cached.slug === slug && cached.events &&
            cached.events.length && now - cached.at < (settings.refreshMinutes || 30) * 60000) {
            refreshing = false;
            cb(null);
            return;
        }
        fetchText(BASE + '/en/' + slug, FETCH_TIMEOUT, function (error, html) {
            if (error) {
                refreshing = false;
                settings.lastError = 'fetch: ' + (error && error.message || error);
                save();
                cb(error);
                return;
            }
            try {
                var conf = parseConfData(html);
                var z = effectiveZone(conf);
                settings.schedule = {
                    at: Date.now(),
                    slug: slug,
                    timezone: z.zone,
                    fixedMinutes: z.fixed,
                    events: buildEvents(conf, Date.now(), z.zone, z.fixed)
                };
                settings.lastError = '';
                save();
                refreshing = false;
                cb(null);
            } catch (parseError) {
                refreshing = false;
                settings.lastError = 'schedule: ' + (parseError && parseError.message || parseError);
                save();
                cb(parseError);
            }
        });
    }

    function fire(event, tag) {
        var command = '/usr/bin/app_launcher -s ' + cleanAppId(settings.appId);
        var execute;
        try {
            execute = ctx.execute(command, 15000);
        } catch (error) {
            settings.lastError = 'exec: ' + (error && error.message || error);
            save();
            return;
        }
        Promise.resolve(execute).then(function () {
            settings.lastLaunch = new Date().toISOString() + ' ' + (tag || event.key);
            settings.lastError = '';
            save();
            lastUiMessage = 'Launched Athan TV';
        }, function (error) {
            settings.lastError = 'exec: ' + (error && error.message || error);
            save();
        });
    }

    function checkEvents(now) {
        var schedule = settings.schedule;
        if (!schedule || !schedule.events) {
            return;
        }
        var fired = [];
        var i;
        for (i = 0; i < schedule.events.length; i++) {
            var event = schedule.events[i];
            if (event.at > now || event.at <= now - LATE_WINDOW) {
                continue;
            }
            if (settings.lastFired[event.key]) {
                continue;
            }
            settings.lastFired[event.key] = now;
            fired.push(event);
        }
        if (fired.length) {
            var keys = Object.keys(settings.lastFired);
            for (i = 0; i < keys.length; i++) {
                if (now - settings.lastFired[keys[i]] > 2 * 86400000) {
                    delete settings.lastFired[keys[i]];
                }
            }
            save();
            for (i = 0; i < fired.length; i++) {
                fire(fired[i]);
            }
        }
    }

    function tick() {
        try {
            if (!settings.enabled || !settings.slug) {
                return;
            }
            var now = Date.now();
            var schedule = settings.schedule;
            var stale = !schedule || !schedule.events || !schedule.events.length ||
                now - schedule.at > (settings.refreshMinutes || 30) * 60000;
            if (stale) {
                refresh(false, function () {
                    checkEvents(Date.now());
                });
            } else {
                checkEvents(now);
            }
        } catch (error) {
            settings.lastError = 'tick: ' + (error && error.message || error);
            save();
        }
    }

    function nextEvent() {
        var schedule = settings.schedule;
        if (!schedule || !schedule.events) {
            return null;
        }
        var now = Date.now();
        for (var i = 0; i < schedule.events.length; i++) {
            if (schedule.events[i].at > now) {
                return schedule.events[i];
            }
        }
        return null;
    }

    function uiPage() {
        var next = nextEvent();
        var statusText = settings.lastError || lastUiMessage ||
            (next ? next.label + ' ' + next.time + ' UTC ' + next.atUtc : 'No schedule yet');
        var html = [
            '<!DOCTYPE html><html><head><meta charset="utf-8">',
            '<meta name="color-scheme" content="light dark">',
            '<title>Athan TV Alarm</title>',
            '<style>',
            'body{font:16px system-ui,sans-serif;margin:0;padding:18px;background:#0b0f14;color:#eee}',
            'h1{font-size:20px;margin:0 0 12px}label{display:block;margin:12px 0 4px;opacity:.75;font-size:13px}',
            'input{width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #445;background:#151b23;color:#eee;font-size:15px}',
            'button{padding:9px 14px;margin:14px 8px 0 0;border:0;border-radius:6px;background:#e9c66a;color:#10151b;font-weight:700;cursor:pointer}',
            'button.alt{background:#28323d;color:#eee}#s{opacity:.8;font-size:13px;margin-top:14px;word-break:break-word}',
            '</style></head><body>',
            '<h1>Athan TV Alarm</h1>',
            '<p>Runs inside Vetro and launches Athan TV at every adhan, even when the app is closed.</p>',
            '<label>Mosque slug (mawaqit.net)</label><input id="slug" value="', escapeHtml(settings.slug), '">',
            '<label>Tizen app id to launch</label><input id="appId" value="', escapeHtml(settings.appId), '">',
            '<label>Poll interval (seconds)</label><input id="poll" type="number" min="10" max="300" value="', escapeHtml(settings.pollSeconds), '">',
            '<label>Fallback UTC offset in minutes (only if this TV has no time zone data)</label>',
            '<input id="offset" placeholder="e.g. 60" value="', escapeHtml(settings.utcOffsetMinutes == null ? '' : settings.utcOffsetMinutes), '">',
            '<label><input id="enabled" type="checkbox" style="width:auto;margin-right:8px"',
            settings.enabled ? ' checked' : '', '>Alarm enabled</label>',
            '<button id="save">Save</button><button id="refresh" class="alt">Refresh schedule</button>',
            '<button id="test" class="alt">Test launch</button>',
            '<div id="s">Status: ', escapeHtml(statusText), '</div>',
            '<script>',
            'function q(id){return document.getElementById(id)}',
            'function cfg(){return{slug:q("slug").value,appId:q("appId").value,',
            'pollSeconds:Math.max(10,Math.min(300,parseInt(q("poll").value,10)||30)),',
            'utcOffsetMinutes:q("offset").value===""?null:(parseInt(q("offset").value,10)||null),',
            'enabled:q("enabled").checked}}',
            'function post(path,body,label){q("s").textContent=label||"Working...";',
            'fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},',
            'body:body?JSON.stringify(body):"{}"}).then(function(r){return r.json()}).then(function(d){',
            'q("s").textContent=label+": "+JSON.stringify(d)}).catch(function(e){q("s").textContent=String(e)})}',
            'q("save").onclick=function(){post("config",cfg(),"Saved")}',
            'q("refresh").onclick=function(){post("refresh",null,"Refreshed")}',
            'q("test").onclick=function(){post("test",null,"Test launch")}',
            'setInterval(function(){fetch("status").then(function(r){return r.json()}).then(function(s){',
            'if(s&&s.note)q("s").textContent=s.note}).catch(function(){})},10000);',
            '</script></body></html>'
        ];
        return html.join('');
    }

    function route(req, res, sub) {
        if (sub === 'ui') {
            htmlResponse(res, uiPage());
            return true;
        }
        if (sub === 'status') {
            var next = nextEvent();
            var note = settings.lastError || lastUiMessage ||
                (next ? 'Next: ' + next.label + ' ' + next.time + ' UTC ' + next.atUtc + ' (' + next.prayer + ')' : 'No schedule');
            jsonResponse(res, {
                ok: true,
                slug: settings.slug,
                enabled: settings.enabled,
                appId: settings.appId,
                timezone: settings.schedule ? settings.schedule.timezone : null,
                scheduleAt: settings.schedule ? new Date(settings.schedule.at).toISOString() : null,
                events: settings.schedule && settings.schedule.events ? settings.schedule.events.length : 0,
                next: next,
                lastLaunch: settings.lastLaunch,
                lastError: settings.lastError,
                note: note
            });
            return true;
        }
        if (sub === 'config' && req.method === 'GET') {
            jsonResponse(res, {
                slug: settings.slug, appId: settings.appId, enabled: settings.enabled,
                pollSeconds: settings.pollSeconds, refreshMinutes: settings.refreshMinutes,
                utcOffsetMinutes: settings.utcOffsetMinutes
            });
            return true;
        }
        if (sub === 'config' && req.method === 'POST') {
            readBody(req, function (error, body) {
                if (error) {
                    jsonResponse(res, { ok: false, error: error.message }, 400);
                    return;
                }
                try {
                    var data = JSON.parse(body);
                    settings.slug = cleanSlug(data.slug);
                    settings.appId = cleanAppId(data.appId);
                    settings.enabled = data.enabled !== false;
                    var poll = parseInt(data.pollSeconds, 10);
                    settings.pollSeconds = isFinite(poll) && poll >= 10 && poll <= 300 ? poll : 30;
                    var offset = data.utcOffsetMinutes;
                    settings.utcOffsetMinutes = offset === null || offset === '' ? null :
                        (isFinite(parseInt(offset, 10)) ? parseInt(offset, 10) : null);
                    settings.schedule = null;
                    settings.lastError = '';
                    save();
                    if (timer) {
                        clearInterval(timer);
                    }
                    timer = setInterval(tick, settings.pollSeconds * 1000);
                    refresh(false, function () {
                        jsonResponse(res, { ok: true, status: settings.lastError || 'ready', slug: settings.slug });
                    });
                } catch (parseError) {
                    jsonResponse(res, { ok: false, error: parseError.message }, 400);
                }
            });
            return true;
        }
        if (sub === 'refresh' && req.method === 'POST') {
            refresh(true, function (error) {
                jsonResponse(res, { ok: !error, error: error ? error.message : null, note: settings.lastError || 'schedule refreshed' }, error ? 500 : 200);
            });
            return true;
        }
        if (sub === 'test' && req.method === 'POST') {
            fire(null, 'test');
            jsonResponse(res, { ok: true, note: 'Launching ' + cleanAppId(settings.appId) });
            return true;
        }
        if (sub === 'schedule' && req.method === 'POST') {
            readBody(req, function (error, body) {
                if (error) {
                    jsonResponse(res, { ok: false, error: error.message }, 400);
                    return;
                }
                try {
                    var data = JSON.parse(body);
                    if (!data || !Array.isArray(data.events)) {
                        throw new Error('events array required');
                    }
                    var events = [];
                    var i;
                    for (i = 0; i < data.events.length; i++) {
                        var ev = data.events[i];
                        var ms = Date.parse(ev.atUtc);
                        if (ev.key && isFinite(ms)) {
                            events.push({
                                key: String(ev.key), prayer: String(ev.prayer || ''),
                                label: String(ev.label || ''), time: String(ev.time || ''),
                                at: ms, atUtc: new Date(ms).toISOString()
                            });
                        }
                    }
                    settings.schedule = { at: Date.now(), slug: settings.slug || 'pushed', timezone: 'pushed', fixedMinutes: null, events: events, pushed: true };
                    settings.lastError = '';
                    save();
                    jsonResponse(res, { ok: true, events: events.length });
                } catch (parseError) {
                    jsonResponse(res, { ok: false, error: parseError.message }, 400);
                }
            });
            return true;
        }
        return false;
    }

    return {
        start: function () {
            load();
            var interval = settings.pollSeconds * 1000;
            timer = setInterval(tick, interval);
            if (timer.unref) {
                timer.unref();
            }
            refresh(false, function () {
                checkEvents(Date.now());
            });
        },
        stop: function () {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
        status: function () {
            var next = nextEvent();
            return {
                mosque: settings.slug || '(not set)',
                enabled: !!settings.enabled,
                appId: settings.appId,
                nextPrayer: next ? next.label + ' at ' + next.time + ' (UTC ' + next.atUtc + ')' : 'none',
                scheduleAt: settings.schedule ? new Date(settings.schedule.at).toISOString() : 'none',
                lastLaunch: settings.lastLaunch || 'never',
                error: settings.lastError || null
            };
        },
        route: route,

        /* Exposed for local tests only; the host ignores extra properties. */
        _test: {
            settings: function () { return settings; },
            load: load,
            save: save,
            tick: tick,
            refresh: refresh,
            checkEvents: checkEvents,
            route: route,
            uiPage: uiPage,
            parseConfData: parseConfData,
            buildEvents: buildEvents,
            zonedToUtc: zonedToUtc,
            zoneParts: zoneParts,
            validTimezone: validTimezone
        }
    };
}

module.exports = function (ctx) {
    return makeCreate(ctx);
};
module.exports._internals = {
    parseConfData: parseConfData,
    buildEvents: buildEvents,
    zonedToUtc: zonedToUtc,
    zoneParts: zoneParts,
    validTimezone: validTimezone
};
