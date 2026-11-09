/*
 * MawaqitData — the whole Mawaqit backend, running inside the TV app.
 *
 * It reads the public Mawaqit directory and each mosque's `confData` directly
 * from mawaqit.net, then builds the same dashboard payload the old FastAPI
 * server produced (adhan/iqama times, next prayer, Jumu'ah, Hijri date and
 * announcements), all in the mosque's own timezone.
 *
 * Transport:
 *   - On a real Tizen TV, requests go through the native Download API, which
 *     is not subject to the browser's CORS rules.
 *   - In a desktop browser (development), it uses XMLHttpRequest/fetch against
 *     the optional `?base=` proxy prefix.
 */
(function (global) {
    "use strict";

    var MAWAQIT_BASE = "https://mawaqit.net";
    var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 AthanTV/1.0";
    var MAP_TTL = 6 * 60 * 60 * 1000;
    var CONF_TTL = 60 * 60 * 1000;
    var STORAGE_PREFIX = "athan-tv-data-v1:";
    var DEFAULT_TIMEOUT = 30000;

    var PRAYER_DEFS = [
        ["fajr", "Fajr", 0, true],
        ["dohr", "Dhuhr", 2, true],
        ["asr", "Asr", 3, true],
        ["maghreb", "Maghrib", 4, true],
        ["icha", "Isha", 5, true]
    ];
    var IQAMA_INDEX = { fajr: 0, dohr: 1, asr: 2, maghreb: 3, icha: 4 };

    var WEEKDAYS = {
        en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        fr: ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    };
    var MONTHS = {
        en: ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"],
        fr: ["janvier", "février", "mars", "avril", "mai", "juin",
            "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
    };
    var HIJRI_MONTHS = {
        en: ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani",
            "Jumada al-Ula", "Jumada al-Akhirah", "Rajab", "Shaban",
            "Ramadan", "Shawwal", "Dhul Qadah", "Dhul Hijjah"],
        fr: ["Mouharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani",
            "Joumada al-Oula", "Joumada al-Akhira", "Rajab", "Chaabane",
            "Ramadan", "Chawwal", "Dhul Qida", "Dhul Hijja"],
        ar: ["محرم", "صفر", "ربيع الأول", "ربيع الثاني",
            "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان",
            "رمضان", "شوال", "ذو القعدة", "ذو الحجة"]
    };

    var memoryCache = {};

    /* ----------------------------- helpers ----------------------------- */

    function pad2(value) {
        return value < 10 ? "0" + value : String(value);
    }

    function isoUtc(ms) {
        return new Date(ms).toISOString();
    }

    function absoluteUrl(value) {
        if (!value || typeof value !== "string") {
            return "";
        }
        if (value.indexOf("//") === 0) {
            return "https:" + value;
        }
        if (value.charAt(0) === "/") {
            return MAWAQIT_BASE + value;
        }
        return value;
    }

    function cleanHtml(value) {
        if (!value) {
            return "";
        }
        return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    function baseUrl() {
        var search = "";
        try {
            search = String((global.location && global.location.search) || "");
        } catch (ignore) {
            search = "";
        }
        var match = /[?&]base=([^&]+)/.exec(search);
        if (match) {
            try {
                var value = decodeURIComponent(match[1]);
                if (value) {
                    return value.replace(/\/+$/, "");
                }
            } catch (ignore) {
                /* fall back to the public base */
            }
        }
        return MAWAQIT_BASE;
    }

    function storageGet(key) {
        try {
            if (typeof global.localStorage === "undefined") {
                return null;
            }
            var raw = global.localStorage.getItem(STORAGE_PREFIX + key) ||
                global.localStorage.getItem("mawaqit-tv-data-v1:" + key);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            if (typeof global.localStorage === "undefined") {
                return;
            }
            global.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
        } catch (error) {
            /* quota exceeded: the in-memory cache still works */
        }
    }

    /* --------------------------- transport ---------------------------- */

    function xhrText(url, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var settled = false;
            var timer = null;

            function finish(fn, value) {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                fn(value);
            }

            if (typeof global.XMLHttpRequest === "undefined") {
                fetchTextHttp(url, timeoutMs).then(resolve, reject);
                return;
            }

            var xhr = new global.XMLHttpRequest();
            timer = setTimeout(function () {
                try {
                    xhr.abort();
                } catch (ignore) {
                    /* ignore */
                }
                finish(reject, new Error("timeout"));
            }, timeoutMs);

            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) {
                    return;
                }
                if (xhr.status >= 200 && xhr.status < 300) {
                    finish(resolve, xhr.responseText);
                } else if (xhr.status === 0) {
                    finish(reject, new Error("network"));
                } else {
                    finish(reject, new Error("HTTP " + xhr.status));
                }
            };
            xhr.onerror = function () {
                finish(reject, new Error("network"));
            };

            try {
                xhr.open("GET", url, true);
                // No custom headers here: a "simple" GET avoids a CORS
                // preflight, which mawaqit.net would reject.
                xhr.send();
            } catch (error) {
                finish(reject, new Error("network"));
            }
        });
    }

    function fetchTextHttp(url, timeoutMs) {
        if (typeof global.fetch !== "function") {
            return Promise.reject(new Error("network"));
        }
        var controller = typeof global.AbortController === "function" ? new global.AbortController() : null;
        var timer = setTimeout(function () {
            if (controller) {
                controller.abort();
            }
        }, timeoutMs);
        var options = { method: "GET", cache: "no-store" };
        if (controller) {
            options.signal = controller.signal;
        }
        return global.fetch(url, options).then(function (response) {
            clearTimeout(timer);
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.text();
        }, function (error) {
            clearTimeout(timer);
            throw error && error.name === "AbortError" ? new Error("timeout") : new Error("network");
        });
    }

    function tizenAvailable() {
        return !!(global.tizen && global.tizen.download && global.tizen.filesystem &&
            global.tizen.DownloadRequest);
    }

    function downloadSupported() {
        try {
            if (global.tizen && global.tizen.systeminfo && global.tizen.systeminfo.getCapability) {
                return global.tizen.systeminfo.getCapability("http://tizen.org/feature/download") !== false;
            }
        } catch (ignore) {
            /* assume it might work */
        }
        return true;
    }

    function readTizenFile(path) {
        return new Promise(function (resolve, reject) {
            var filesystem = global.tizen.filesystem;

            try {
                if (typeof filesystem.openFile === "function") {
                    var handle = filesystem.openFile(path, "r");
                    var text = handle.readString();
                    try {
                        handle.close();
                    } catch (ignore) {
                        /* ignore */
                    }
                    resolve(text);
                    return;
                }
            } catch (error) {
                /* fall back to the older resolve/openStream API */
            }

            try {
                filesystem.resolve(path, function (file) {
                    try {
                        file.openStream("r", function (stream) {
                            var content = "";
                            try {
                                content = typeof stream.readString === "function"
                                    ? stream.readString()
                                    : stream.read();
                            } catch (error) {
                                /* leave empty */
                            }
                            try {
                                stream.close();
                            } catch (ignore) {
                                /* ignore */
                            }
                            resolve(content);
                        }, reject, "r");
                    } catch (error) {
                        reject(error);
                    }
                }, reject, "r");
            } catch (error) {
                reject(error);
            }
        });
    }

    function deleteTizenFile(path) {
        try {
            if (global.tizen.filesystem && typeof global.tizen.filesystem.deleteFile === "function") {
                global.tizen.filesystem.deleteFile(path);
            }
        } catch (ignore) {
            /* best effort */
        }
    }

    function downloadOnce(url, destination, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var extension = url.indexOf("/api/") !== -1 ? ".json" : ".html";
            var fileName = "mawaqit-" + Date.now() + "-" +
                Math.floor(Math.random() * 1000000) + extension;
            var request;
            var id = null;
            var settled = false;
            var timer = null;

            function finish(fn, value) {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                fn(value);
            }

            try {
                request = new global.tizen.DownloadRequest(url, destination, fileName, "ALL", {
                    "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
                    "User-Agent": USER_AGENT
                });
            } catch (error) {
                try {
                    request = new global.tizen.DownloadRequest(url, destination, fileName);
                } catch (error2) {
                    finish(reject, error2);
                    return;
                }
            }

            timer = setTimeout(function () {
                try {
                    if (id !== null && global.tizen.download.cancel) {
                        global.tizen.download.cancel(id);
                    }
                } catch (ignore) {
                    /* ignore */
                }
                finish(reject, new Error("timeout"));
            }, timeoutMs);

            try {
                id = global.tizen.download.start(request, {
                    oncompleted: function (downloadId, path) {
                        readTizenFile(path).then(function (text) {
                            deleteTizenFile(path);
                            finish(resolve, text);
                        }, function (error) {
                            deleteTizenFile(path);
                            finish(reject, error);
                        });
                    },
                    onfailed: function (downloadId, error) {
                        finish(reject, new Error("download:" +
                            (error && (error.message || error.name) || "failed")));
                    }
                });
            } catch (error) {
                finish(reject, error);
            }
        });
    }

    function downloadText(url, timeoutMs) {
        // Prefer the app's private storage, then the documented Downloads root.
        var destinations = ["wgt-private", "downloads"];
        var index = 0;

        function attempt() {
            if (index >= destinations.length) {
                return Promise.reject(new Error("download"));
            }
            var destination = destinations[index++];
            return downloadOnce(url, destination, timeoutMs).catch(attempt);
        }

        return attempt();
    }

    function fetchText(url, timeoutMs) {
        var timeout = timeoutMs || DEFAULT_TIMEOUT;
        // On Tizen, <access origin="*" subdomains="true"/> in config.xml allows direct
        // cross-origin requests. Try direct XHR first for speed and to avoid flash disk
        // wear/toast popups; fall back to Tizen Download API if XHR is blocked.
        return xhrText(url, timeout).catch(function (xhrError) {
            if (tizenAvailable() && downloadSupported()) {
                return downloadText(url, timeout);
            }
            throw xhrError;
        });
    }

    /* ------------------------- normalisation -------------------------- */

    function normalize(value) {
        var text = String(value || "");
        if (text.normalize) {
            text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        }
        return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }

    var LATIN_RE = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/;
    var WORD_FIXES = {
        mosquee: "Mosquée",
        masjid: "Masjid",
        assalam: "Assalam",
        salam: "Salam",
        nour: "Nour",
        el: "El"
    };

    function prettifySlug(slug, countryFullName) {
        var text = String(slug || "").replace(/[_-]+/g, " ").trim();
        if (countryFullName) {
            var suffix = String(countryFullName).toLowerCase();
            if (text.toLowerCase().slice(-suffix.length) === suffix) {
                text = text.slice(0, text.length - String(countryFullName).length).trim();
            }
        }
        var words = text.split(/\s+/);
        var result = [];
        for (var i = 0; i < words.length; i++) {
            var word = words[i];
            if (!word) {
                continue;
            }
            result.push(WORD_FIXES[word.toLowerCase()] ||
                word.charAt(0).toUpperCase() + word.slice(1));
        }
        return result.join(" ");
    }

    function displayName(name, slug, countryFullName) {
        name = String(name || "").trim();
        if (name && LATIN_RE.test(name)) {
            return name;
        }
        return prettifySlug(slug, countryFullName) || name;
    }

    function cleanMapItem(item) {
        if (!item || typeof item !== "object") {
            return null;
        }
        var slug = item.slug || item.uuid || "";
        var name = item.name || item.label || "";
        var countryFullName = item.countryFullName || "";
        return {
            slug: slug,
            name: name,
            displayName: displayName(name, slug, countryFullName),
            label: item.label || name,
            city: item.city || "",
            zipcode: item.zipcode || "",
            address: item.address || "",
            country: String(item.country || "").toUpperCase(),
            countryFullName: countryFullName,
            lat: item.lat,
            lng: item.lng,
            image: item.image1 || item.image || ""
        };
    }

    function scoreMosque(mosque, needle) {
        var haystacks = [
            normalize(mosque.name),
            normalize(mosque.city),
            normalize(mosque.zipcode),
            normalize(mosque.address),
            normalize(mosque.slug)
        ];
        var i;
        for (i = 0; i < haystacks.length; i++) {
            if (haystacks[i] === needle) {
                return 0;
            }
        }
        for (i = 0; i < haystacks.length; i++) {
            if (haystacks[i].indexOf(needle) === 0) {
                return 1;
            }
        }
        for (i = 0; i < haystacks.length; i++) {
            if ((" " + haystacks[i]).indexOf(" " + needle) !== -1) {
                return 2;
            }
        }
        for (i = 0; i < haystacks.length; i++) {
            if (haystacks[i].indexOf(needle) !== -1) {
                return 3;
            }
        }
        var words = needle.split(/\s+/);
        var combined = haystacks.join(" ");
        for (i = 0; i < words.length; i++) {
            if (words[i] && combined.indexOf(words[i]) === -1) {
                return null;
            }
        }
        return words.length ? 4 : null;
    }

    /* --------------------------- time zones --------------------------- */

    function validTimezone(name) {
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: name }).format(new Date());
            return name;
        } catch (error) {
            return "UTC";
        }
    }

    function zoneParts(date, timeZone) {
        var options = {
            timeZone: timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        };
        var formatter = new Intl.DateTimeFormat("en-US", options);
        var hour;
        var minute;
        var second;
        var year;
        var month;
        var day;

        if (typeof formatter.formatToParts === "function") {
            var parts = formatter.formatToParts(date);
            var map = {};
            for (var i = 0; i < parts.length; i++) {
                map[parts[i].type] = parts[i].value;
            }
            year = parseInt(map.year, 10);
            month = parseInt(map.month, 10);
            day = parseInt(map.day, 10);
            hour = parseInt(map.hour, 10);
            minute = parseInt(map.minute, 10);
            second = parseInt(map.second, 10);
        } else {
            var match = /(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/
                .exec(formatter.format(date));
            if (!match) {
                throw new Error("timezone");
            }
            month = parseInt(match[1], 10);
            day = parseInt(match[2], 10);
            year = parseInt(match[3], 10);
            hour = parseInt(match[4], 10);
            minute = parseInt(match[5], 10);
            second = parseInt(match[6] || "0", 10);
        }

        if (hour === 24) {
            hour = 0;
        }
        return {
            year: year,
            month: month,
            day: day,
            hour: hour,
            minute: minute,
            second: second
        };
    }

    function zoneOffsetMs(epochMs, timeZone) {
        var parts = zoneParts(new Date(epochMs), timeZone);
        var asUtc = Date.UTC(parts.year, parts.month - 1, parts.day,
            parts.hour, parts.minute, parts.second);
        return asUtc - Math.floor(epochMs / 1000) * 1000;
    }

    function zonedToUtc(year, month, day, hour, minute, timeZone) {
        var guess = Date.UTC(year, month - 1, day, hour, minute, 0);
        var firstOffset = zoneOffsetMs(guess, timeZone);
        var firstGuess = guess - firstOffset;
        var secondOffset = zoneOffsetMs(firstGuess, timeZone);
        if (secondOffset !== firstOffset) {
            return guess - secondOffset;
        }
        return firstGuess;
    }

    /* --------------------------- calendar ------------------------------ */

    function parseHm(value) {
        if (value === null || typeof value === "undefined") {
            return null;
        }
        var match = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
        if (!match) {
            return null;
        }
        var hour = parseInt(match[1], 10);
        var minute = parseInt(match[2], 10);
        if (hour > 23 || minute > 59) {
            return null;
        }
        return { h: hour, m: minute };
    }

    function hmText(value) {
        return pad2(value.h) + ":" + pad2(value.m);
    }

    function calendarEntry(conf, year, month, day) {
        var calendar = conf.calendar;
        if (!Array.isArray(calendar) || calendar.length < 12) {
            return null;
        }
        var values = calendar[month - 1] && calendar[month - 1][String(day)];
        if (Array.isArray(values) && values.length >= 6) {
            return values;
        }
        return null;
    }

    function timesForDay(conf, year, month, day, today) {
        var entry = calendarEntry(conf, year, month, day);
        if (entry) {
            return {
                fajr: entry[0],
                shuruq: entry[1],
                dohr: entry[2],
                asr: entry[3],
                maghreb: entry[4],
                icha: entry[5]
            };
        }
        var isToday = today && today.y === year && today.m === month && today.d === day;
        if (isToday && Array.isArray(conf.times) && conf.times.length >= 5) {
            return {
                fajr: conf.times[0],
                shuruq: conf.shuruq || "",
                dohr: conf.times[1],
                asr: conf.times[2],
                maghreb: conf.times[3],
                icha: conf.times[4]
            };
        }
        return {};
    }

    function iqamaValues(conf, month, day) {
        var calendar = conf.iqamaCalendar;
        if (!Array.isArray(calendar) || calendar.length < 12) {
            return null;
        }
        var values = calendar[month - 1] && calendar[month - 1][String(day)];
        if (Array.isArray(values) && values.length >= 5) {
            return values;
        }
        return null;
    }

    function resolveIqama(raw, adhan, dateParts, timeZone) {
        if (raw === null || typeof raw === "undefined") {
            return null;
        }
        var text = String(raw).trim();
        if (!text) {
            return null;
        }

        if (/^[+-]?\d+$/.test(text)) {
            if (!adhan) {
                return null;
            }
            var offset = parseInt(text, 10);
            var total = adhan.h * 60 + adhan.m + offset;
            total = ((total % 1440) + 1440) % 1440;
            return {
                ms: zonedToUtc(dateParts.y, dateParts.m, dateParts.d,
                    adhan.h, adhan.m, timeZone) + offset * 60000,
                text: pad2(Math.floor(total / 60)) + ":" + pad2(total % 60)
            };
        }

        var parsed = parseHm(text);
        if (!parsed) {
            return null;
        }
        return {
            ms: zonedToUtc(dateParts.y, dateParts.m, dateParts.d,
                parsed.h, parsed.m, timeZone),
            text: hmText(parsed)
        };
    }

    /* --------------------------- overview ------------------------------ */

    function buildDay(conf, year, month, day, timeZone, today, includeShuruq) {
        var times = timesForDay(conf, year, month, day, today);
        var rawIqama = iqamaValues(conf, month, day);
        var iqamaEnabled = conf.iqamaEnabled !== false && rawIqama !== null;
        var prayers = [];
        var i;

        for (i = 0; i < PRAYER_DEFS.length; i++) {
            var key = PRAYER_DEFS[i][0];
            var label = PRAYER_DEFS[i][1];
            var isPrayer = PRAYER_DEFS[i][3];
            var adhan = parseHm(times[key]);
            if (!adhan) {
                continue;
            }
            var adhanMs = zonedToUtc(year, month, day, adhan.h, adhan.m, timeZone);
            var iqama = null;

            if (iqamaEnabled && isPrayer) {
                iqama = resolveIqama(rawIqama[IQAMA_INDEX[key]], adhan,
                    { y: year, m: month, d: day }, timeZone);
            }

            prayers.push({
                key: key,
                label: label,
                adhan: hmText(adhan),
                iqama: iqama ? iqama.text : null,
                atUtc: isoUtc(adhanMs),
                iqamaAtUtc: iqama ? isoUtc(iqama.ms) : null,
                isPrayer: isPrayer
            });

            if (key === "fajr" && includeShuruq) {
                var shuruq = parseHm(times.shuruq);
                if (shuruq) {
                    prayers.push({
                        key: "shuruq",
                        label: "Shuruq",
                        adhan: hmText(shuruq),
                        iqama: null,
                        atUtc: isoUtc(zonedToUtc(year, month, day,
                            shuruq.h, shuruq.m, timeZone)),
                        iqamaAtUtc: null,
                        isPrayer: false
                    });
                }
            }
        }
        return prayers;
    }

    function buildJumua(conf, year, month, day, timeZone) {
        var dohr = parseHm(timesForDay(conf, year, month, day, null).dohr);
        var candidates;

        if (conf.jumuaAsDuhr && dohr) {
            candidates = [["Jumu'ah", hmText(dohr)]];
        } else {
            candidates = [
                ["Jumu'ah", conf.jumua],
                ["Jumu'ah 2", conf.jumua2],
                ["Jumu'ah 3", conf.jumua3]
            ];
        }

        var result = [];
        var seen = {};
        for (var i = 0; i < candidates.length; i++) {
            var label = candidates[i][0];
            var raw = String(candidates[i][1] || "").trim();
            if (!raw) {
                continue;
            }
            var text;
            if (/^[+-]?\d+$/.test(raw) && dohr) {
                var total = dohr.h * 60 + dohr.m + parseInt(raw, 10);
                total = ((total % 1440) + 1440) % 1440;
                text = pad2(Math.floor(total / 60)) + ":" + pad2(total % 60);
            } else {
                var parsed = parseHm(raw);
                if (!parsed) {
                    continue;
                }
                text = hmText(parsed);
            }
            if (seen[text]) {
                continue;
            }
            seen[text] = true;
            result.push({ label: label, time: text });
        }
        return result;
    }

    function announcementTime(value, timeZone) {
        if (!value) {
            return NaN;
        }
        var text = String(value).trim();
        // Naive timestamps ("2026-11-07 18:00:00") are Mawaqit wall-clock time.
        var naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
        if (naive) {
            return zonedToUtc(
                parseInt(naive[1], 10),
                parseInt(naive[2], 10),
                parseInt(naive[3], 10),
                parseInt(naive[4], 10),
                parseInt(naive[5], 10),
                timeZone
            ) + parseInt(naive[6] || "0", 10) * 1000;
        }
        return Date.parse(text);
    }

    function buildAnnouncements(conf, nowMs, timeZone) {
        var raw = conf.announcements;
        if (!Array.isArray(raw)) {
            return [];
        }
        var current = [];
        for (var i = 0; i < raw.length && current.length < 5; i++) {
            var item = raw[i];
            if (!item || typeof item !== "object") {
                continue;
            }
            var start = announcementTime(item.startDate, timeZone);
            var end = announcementTime(item.endDate, timeZone);
            if (!isNaN(start) && start > nowMs) {
                continue;
            }
            if (!isNaN(end) && end < nowMs) {
                continue;
            }
            var title = cleanHtml(item.title || item.name || "");
            var content = cleanHtml(item.content || item.text || "");
            if (!title && !content) {
                continue;
            }
            current.push({
                title: title,
                content: content,
                image: absoluteUrl(item.image)
            });
        }
        return current;
    }

    function hijriDate(year, month, day, adjustment) {
        var adjusted = new Date(Date.UTC(year, month - 1, day) + adjustment * 86400000);
        year = adjusted.getUTCFullYear();
        month = adjusted.getUTCMonth() + 1;
        day = adjusted.getUTCDate();

        var jd = Math.trunc((1461 * (year + 4800 + Math.trunc((month - 14) / 12))) / 4);
        jd += Math.trunc((367 * (month - 2 - 12 * Math.trunc((month - 14) / 12))) / 12);
        jd -= Math.trunc((3 * Math.trunc((year + 4900 + Math.trunc((month - 14) / 12)) / 100)) / 4);
        jd += day - 32075;

        var l = jd - 1948440 + 10632;
        var n = Math.trunc((l - 1) / 10631);
        l = l - 10631 * n + 354;
        var j = Math.trunc((10985 - l) / 5316) * Math.trunc((50 * l) / 17719) +
            Math.trunc(l / 5670) * Math.trunc((43 * l) / 15238);
        l = l - Math.trunc((30 - j) / 15) * Math.trunc((17719 * j) / 50) -
            Math.trunc(j / 16) * Math.trunc((15238 * j) / 43) + 29;
        var hijriMonth = Math.trunc((24 * l) / 709);
        var hijriDay = l - Math.trunc((709 * hijriMonth) / 24);
        var hijriYear = 30 * n + j - 30;

        hijriMonth = Math.max(1, Math.min(12, hijriMonth));
        return {
            day: hijriDay,
            month: hijriMonth,
            year: hijriYear,
            monthName: {
                en: HIJRI_MONTHS.en[hijriMonth - 1],
                fr: HIJRI_MONTHS.fr[hijriMonth - 1],
                ar: HIJRI_MONTHS.ar[hijriMonth - 1]
            },
            formatted: {
                en: hijriDay + " " + HIJRI_MONTHS.en[hijriMonth - 1] + " " + hijriYear,
                fr: hijriDay + " " + HIJRI_MONTHS.fr[hijriMonth - 1] + " " + hijriYear,
                ar: (hijriDay + " " + HIJRI_MONTHS.ar[hijriMonth - 1] + " " + hijriYear)
                    .replace(/[0-9]/g, function (digit) {
                        return "٠١٢٣٤٥٦٧٨٩".charAt(parseInt(digit, 10));
                    })
            }
        };
    }

    function gregorianDisplay(year, month, day) {
        var weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
        return {
            en: WEEKDAYS.en[weekday] + " " + day + " " + MONTHS.en[month - 1] + " " + year,
            fr: WEEKDAYS.fr[weekday] + " " + day + " " + MONTHS.fr[month - 1] + " " + year
        };
    }

    function copyPrayer(prayer) {
        return {
            key: prayer.key,
            label: prayer.label,
            adhan: prayer.adhan,
            iqama: prayer.iqama,
            atUtc: prayer.atUtc,
            iqamaAtUtc: prayer.iqamaAtUtc,
            isPrayer: prayer.isPrayer
        };
    }

    function buildOverview(conf, slug, nowMs) {
        var timeZone = validTimezone(conf.timezone || "UTC");
        var now = zoneParts(new Date(nowMs), timeZone);
        var today = { y: now.year, m: now.month, d: now.day };
        var tomorrowDate = new Date(Date.UTC(today.y, today.m - 1, today.d) + 86400000);
        var tomorrow = {
            y: tomorrowDate.getUTCFullYear(),
            m: tomorrowDate.getUTCMonth() + 1,
            d: tomorrowDate.getUTCDate()
        };

        var todayPrayers = buildDay(conf, today.y, today.m, today.d, timeZone, today, true);
        var tomorrowPrayers = buildDay(conf, tomorrow.y, tomorrow.m, tomorrow.d, timeZone, today, true);

        var next = null;
        for (var i = 0; i < todayPrayers.length; i++) {
            if (!todayPrayers[i].isPrayer) {
                continue;
            }
            var at = Date.parse(todayPrayers[i].atUtc);
            if (at > nowMs) {
                next = copyPrayer(todayPrayers[i]);
                next.day = "today";
                next.secondsLeft = Math.floor((at - nowMs) / 1000);
                break;
            }
        }
        if (!next) {
            for (var j = 0; j < tomorrowPrayers.length; j++) {
                if (!tomorrowPrayers[j].isPrayer) {
                    continue;
                }
                var tomorrowAt = Date.parse(tomorrowPrayers[j].atUtc);
                next = copyPrayer(tomorrowPrayers[j]);
                next.day = "tomorrow";
                next.secondsLeft = Math.floor((tomorrowAt - nowMs) / 1000);
                break;
            }
        }

        var hijri = hijriDate(today.y, today.m, today.d,
            parseInt(conf.hijriAdjustment || 0, 10) || 0);
        var weekday = (new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay() + 6) % 7;

        return {
            mosque: {
                slug: slug,
                name: conf.name || conf.label || slug,
                displayName: displayName(conf.name || conf.label || "", slug, ""),
                label: conf.label || conf.name || slug,
                association: conf.association || "",
                site: conf.site || "",
                countryCode: conf.countryCode || "",
                timezone: conf.timezone || "UTC",
                latitude: conf.latitude,
                longitude: conf.longitude,
                image: absoluteUrl(conf.image),
                logo: absoluteUrl(conf.logo),
                type: conf.type || "MOSQUE"
            },
            date: {
                gregorian: today.y + "-" + pad2(today.m) + "-" + pad2(today.d),
                gregorianDisplay: gregorianDisplay(today.y, today.m, today.d),
                hijri: hijri,
                weekday: weekday
            },
            now: {
                utc: isoUtc(nowMs),
                utcOffsetMinutes: Math.round(zoneOffsetMs(nowMs, timeZone) / 60000)
            },
            prayers: todayPrayers,
            tomorrow: tomorrowPrayers,
            next: next,
            jumua: buildJumua(conf, today.y, today.m, today.d, timeZone),
            iqamaEnabled: conf.iqamaEnabled !== false,
            announcements: buildAnnouncements(conf, nowMs, timeZone)
        };
    }

    /* -------------------------- confData ------------------------------- */

    function extractConfData(html) {
        var marker = /\bconfData\s*=\s*\{/.exec(html);
        if (!marker) {
            return null;
        }
        var start = html.indexOf("{", marker.index);
        if (start === -1) {
            return null;
        }
        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var i = start; i < html.length; i++) {
            var ch = html.charAt(i);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === "\\") {
                    escaped = true;
                } else if (ch === '"') {
                    inString = false;
                }
            } else if (ch === '"') {
                inString = true;
            } else if (ch === "{") {
                depth++;
            } else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    return html.slice(start, i + 1);
                }
            }
        }
        return null;
    }

    function parseConfData(html) {
        var json = extractConfData(html);
        if (!json) {
            throw new Error("parse");
        }
        var conf = JSON.parse(json);
        if (!conf || typeof conf !== "object") {
            throw new Error("parse");
        }
        return conf;
    }

    /* ----------------------------- API --------------------------------- */

    function getCountries() {
        var raw = global.MAWAQIT_COUNTRIES || [];
        var result = [];
        for (var i = 0; i < raw.length; i++) {
            var country = raw[i];
            result.push({
                code: country.code,
                name: { en: country.en, fr: country.fr },
                count: country.count || 0,
                lat: country.lat,
                lng: country.lng
            });
        }
        return result;
    }

    function getMap(countryCode, force) {
        var code = String(countryCode || "").trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) {
            return Promise.reject(new Error("country"));
        }

        var key = "map:" + code;
        var now = Date.now();
        if (!force && memoryCache[key] && now - memoryCache[key].at < MAP_TTL) {
            return Promise.resolve(memoryCache[key].data);
        }

        var stored = force ? null : storageGet(key);
        if (stored && stored.at && now - stored.at < MAP_TTL && Array.isArray(stored.data)) {
            memoryCache[key] = stored;
            return Promise.resolve(stored.data);
        }

        return fetchText(baseUrl() + "/api/2.0/mosque/map/" + code, 60000)
            .then(function (text) {
                var payload = JSON.parse(text);
                if (!Array.isArray(payload)) {
                    throw new Error("parse");
                }
                var mosques = [];
                for (var i = 0; i < payload.length; i++) {
                    var mosque = cleanMapItem(payload[i]);
                    if (mosque && mosque.slug) {
                        if (!mosque.country) {
                            mosque.country = code;
                        }
                        mosques.push(mosque);
                    }
                }
                memoryCache[key] = { at: now, data: mosques };
                storageSet(key, memoryCache[key]);
                return mosques;
            });
    }

    function searchMosques(countryCode, query, limit) {
        var needle = normalize(query);
        if (needle.length < 2) {
            return Promise.reject(new Error("query"));
        }
        return getMap(countryCode).then(function (mosques) {
            var matches = [];
            for (var i = 0; i < mosques.length; i++) {
                var score = scoreMosque(mosques[i], needle);
                if (score !== null) {
                    matches.push({ score: score, mosque: mosques[i] });
                }
            }
            matches.sort(function (left, right) {
                if (left.score !== right.score) {
                    return left.score - right.score;
                }
                var leftName = normalize(left.mosque.name);
                var rightName = normalize(right.mosque.name);
                if (leftName < rightName) {
                    return -1;
                }
                if (leftName > rightName) {
                    return 1;
                }
                var leftCity = left.mosque.city || "";
                var rightCity = right.mosque.city || "";
                return leftCity < rightCity ? -1 : (leftCity > rightCity ? 1 : 0);
            });
            var size = Math.max(1, Math.min(limit || 40, 200));
            var results = [];
            for (var j = 0; j < matches.length && j < size; j++) {
                results.push(matches[j].mosque);
            }
            return {
                query: String(query || "").trim(),
                countries: [String(countryCode || "").toUpperCase()],
                total: matches.length,
                results: results
            };
        });
    }

    function getConf(slug, force) {
        var key = "conf:" + slug;
        var now = Date.now();
        if (!force && memoryCache[key] && now - memoryCache[key].at < CONF_TTL) {
            return Promise.resolve(memoryCache[key].data);
        }
        return fetchText(baseUrl() + "/en/" + encodeURIComponent(slug), 45000)
            .then(function (html) {
                var conf = parseConfData(html);
                memoryCache[key] = { at: now, data: conf };
                return conf;
            });
    }

    function getOverview(slug, force) {
        return getConf(slug, force).then(function (conf) {
            return buildOverview(conf, slug, Date.now());
        });
    }

    function ping() {
        // Fetch the largest public directory once: it proves that the TV can
        // reach mawaqit.net through whichever transport is available.
        return getMap("FR", true).then(function () {
            return true;
        });
    }

    global.MawaqitData = {
        baseUrl: baseUrl,
        countries: getCountries,
        map: getMap,
        search: searchMosques,
        overview: getOverview,
        conf: getConf,
        ping: ping,
        tizen: tizenAvailable,
        // Exposed for tests/tools.
        _buildOverview: buildOverview,
        _parseConfData: parseConfData,
        _displayName: displayName,
        _normalize: normalize
    };
})(typeof window !== "undefined" ? window : this);
