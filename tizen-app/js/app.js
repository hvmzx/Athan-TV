(function () {
    "use strict";

    var STORAGE_KEY = "athan-tv-state-v1";
    var REFRESH_INTERVAL = 5 * 60 * 1000;
    var PRAYER_ICONS = {
        fajr: "☾",
        shuruq: "↑",
        dohr: "☀",
        asr: "◐",
        maghreb: "☾",
        icha: "✦"
    };

    var state = {
        netStatus: "unknown",
        language: "fr",
        notifications: true,
        sound: true,
        voice: false,
        preAlertMinutes: 10,
        mosque: null,
        overview: null,
        overviewFetchedAt: 0,
        countries: [],
        screen: "setup",
        setupStep: 1,
        country: null,
        showAllCountries: false,
        overlay: null,
        skewMs: 0,
        dashStatus: "",
        dashStatusClass: "",
        lastAdhanKey: "",
        lastPreKey: "",
        prayerOverlayIqamaAt: "",
        prayerOverlayIqamaText: "",
        tickerTimer: null,
        tickerIndex: 0,
        toastTimer: null,
        overlayTimer: null,
        lastRefreshAt: 0,
        refreshing: false,
        searchTotal: null,
        audioCtx: null
    };

    function $(id) {
        return document.getElementById(id);
    }

    function $$(selector) {
        return Array.prototype.slice.call(document.querySelectorAll(selector));
    }

    function pad2(value) {
        return value < 10 ? "0" + value : String(value);
    }

    /* ------------------------------ state ------------------------------ */

    function loadState() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY) || window.localStorage.getItem("mawaqit-tv-state-v1");
            if (!raw) {
                return;
            }
            var data = JSON.parse(raw);

            if (data.language === "fr" || data.language === "en") {
                state.language = data.language;
            }
            if (typeof data.notifications === "boolean") {
                state.notifications = data.notifications;
            }
            if (typeof data.sound === "boolean") {
                state.sound = data.sound;
            }
            if (typeof data.voice === "boolean") {
                state.voice = data.voice;
            }
            if (typeof data.preAlertMinutes === "number") {
                state.preAlertMinutes = data.preAlertMinutes;
            }
            if (data.mosque && data.mosque.slug) {
                state.mosque = data.mosque;
            }
            if (data.overview && data.overview.mosque) {
                state.overview = data.overview;
            }
            if (data.overviewFetchedAt) {
                state.overviewFetchedAt = data.overviewFetchedAt;
            }
            if (data.lastAdhanKey) {
                state.lastAdhanKey = data.lastAdhanKey;
            }
        } catch (error) {
            /* ignore corrupted storage */
        }
    }

    function saveState() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
                language: state.language,
                notifications: state.notifications,
                sound: state.sound,
                voice: state.voice,
                preAlertMinutes: state.preAlertMinutes,
                mosque: state.mosque,
                overview: state.overview,
                overviewFetchedAt: state.overviewFetchedAt,
                lastAdhanKey: state.lastAdhanKey
            }));
        } catch (error) {
            /* storage full or unavailable */
        }
    }

    /* ----------------------------- i18n ----------------------------- */

    function t(key) {
        var pack = window.I18N[state.language] || window.I18N.en;
        if (Object.prototype.hasOwnProperty.call(pack, key)) {
            return pack[key];
        }
        var fallback = window.I18N.en;
        return Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : key;
    }

    function tpl(key, values) {
        var text = t(key);
        if (!values) {
            return text;
        }
        Object.keys(values).forEach(function (name) {
            text = text.split("{" + name + "}").join(String(values[name]));
        });
        return text;
    }

    function errorText(error) {
        var message = (error && error.message) || "";
        if (message === "timeout") {
            return t("errorTimeout");
        }
        if (message === "parse") {
            return t("errorParse");
        }
        if (message.indexOf("HTTP ") === 0) {
            return message;
        }
        return t("errorNetwork");
    }

    function prayerName(key) {
        return t("prayer_" + key);
    }

    function countryName(country) {
        if (!country) {
            return "";
        }
        return (country.name && (country.name[state.language] || country.name.en)) || country.code;
    }

    function normalizeText(value) {
        var text = String(value || "").toLowerCase();
        if (text.normalize) {
            text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        }
        return text;
    }

    function mosqueLabel() {
        var mosque = state.mosque || {};
        var name = mosque.displayName || mosque.name || mosque.slug || "";
        return mosque.city ? name + " · " + mosque.city : name;
    }

    /* ---------------------------- helpers ---------------------------- */

    function setStatus(id, text, cls) {
        var element = $(id);
        if (!element) {
            return;
        }
        element.textContent = text || "";
        element.className = "status-line" + (cls ? " " + cls : "");
    }

    function setDashStatus(key, cls) {
        state.dashStatus = key || "";
        state.dashStatusClass = cls || "";
        updateDashStatusLabel();
    }

    function updateDashStatusLabel() {
        var label = $("dash-status");
        var dot = $("dash-dot");
        if (label) {
            label.textContent = state.dashStatus ? t(state.dashStatus) : "—";
        }
        if (dot) {
            dot.className = "dot" + (state.dashStatusClass ? " " + state.dashStatusClass : "");
        }
    }

    function updateNetFooter() {
        var dot = $("net-dot");
        var label = $("net-label");
        if (label) {
            label.textContent = t("dataSource");
        }
        if (dot) {
            dot.className = "dot" +
                (state.netStatus && state.netStatus !== "unknown" ? " " + state.netStatus : "");
        }
    }

    function netOk() {
        state.netStatus = "ok";
        updateNetFooter();
    }

    function netError() {
        state.netStatus = "error";
        updateNetFooter();
    }

    function mosqueOffsetMs() {
        if (state.overview && state.overview.now && typeof state.overview.now.utcOffsetMinutes === "number") {
            return state.overview.now.utcOffsetMinutes * 60000;
        }
        return 0;
    }

    function mosqueDateString(epochMs) {
        var date = new Date(epochMs + mosqueOffsetMs());
        return date.getUTCFullYear() + "-" + pad2(date.getUTCMonth() + 1) + "-" + pad2(date.getUTCDate());
    }

    function mosqueTimeString(epochMs) {
        var date = new Date(epochMs - state.skewMs + mosqueOffsetMs());
        return pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes());
    }

    function formatCountdown(ms) {
        var total = Math.max(0, Math.floor(ms / 1000));
        var hours = Math.floor(total / 3600);
        var minutes = Math.floor((total % 3600) / 60);
        var seconds = total % 60;
        return pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds);
    }

    /* ----------------------------- audio ----------------------------- */

    function ensureAudio() {
        try {
            if (!state.audioCtx) {
                var Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) {
                    return null;
                }
                state.audioCtx = new Ctx();
            }
            if (state.audioCtx.state === "suspended" && state.audioCtx.resume) {
                state.audioCtx.resume();
            }
            return state.audioCtx;
        } catch (error) {
            return null;
        }
    }

    function isAdhanPlaying() {
        var player = $("adhan-player");
        return !!(player && !player.paused && !player.ended && player.currentTime > 0);
    }

    function playAdhanAudio() {
        if (!state.sound) {
            return;
        }
        var player = $("adhan-player");
        if (player) {
            try {
                player.currentTime = 0;
                var promise = player.play();
                if (promise && typeof promise.catch === "function") {
                    promise.catch(function () {
                        // Fall back to synthesized chime if audio playback fails
                        playChime(true);
                    });
                }
                return;
            } catch (error) {
                /* fallback to synthesized chime */
            }
        }
        playChime(true);
    }

    function stopAdhanAudio() {
        var player = $("adhan-player");
        if (player) {
            try {
                player.pause();
                player.currentTime = 0;
            } catch (ignore) {
                /* ignore */
            }
        }
    }

    function playTone(ctx, frequency, when, duration, volume) {
        try {
            var oscillator = ctx.createOscillator();
            var gain = ctx.createGain();
            oscillator.type = "sine";
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, when);
            gain.gain.exponentialRampToValueAtTime(volume, when + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start(when);
            oscillator.stop(when + duration + 0.05);
        } catch (error) {
            /* ignore audio errors */
        }
    }

    function playChime(big) {
        if (!state.sound) {
            return;
        }
        var ctx = ensureAudio();
        if (!ctx) {
            return;
        }
        var now = ctx.currentTime + 0.08;
        var notes = big ? [523.25, 659.25, 783.99, 1046.50] : [659.25, 880.00];
        var spacing = big ? 0.55 : 0.34;
        for (var i = 0; i < notes.length; i++) {
            playTone(ctx, notes[i], now + i * spacing, big ? 1.7 : 0.75, big ? 0.18 : 0.11);
            if (big) {
                playTone(ctx, notes[i] / 2, now + i * spacing, 1.9, 0.05);
            }
        }
    }

    function speak(text) {
        if (!state.voice) {
            return;
        }
        try {
            if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
                return;
            }
            var utterance = new window.SpeechSynthesisUtterance(text);
            utterance.lang = state.language === "fr" ? "fr-FR" : "en-US";
            utterance.rate = 0.92;
            utterance.pitch = 1;
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utterance);
        } catch (error) {
            /* speech is best effort */
        }
    }

    function sendNotification(title, body, soundFile) {
        if (!state.notifications) {
            return;
        }
        try {
            if (window.tizen && window.tizen.notification && window.tizen.StatusNotification) {
                var notificationDict = {
                    content: body,
                    iconPath: "icon.png"
                };
                if (state.sound && soundFile) {
                    notificationDict.soundPath = soundFile;
                }
                var appId = null;
                try {
                    if (window.tizen.application && window.tizen.application.getCurrentApplication) {
                        appId = window.tizen.application.getCurrentApplication().appInfo.id;
                    }
                } catch (ignore) {}
                if (appId) {
                    notificationDict.appId = appId;
                } else {
                    notificationDict.appId = "AthanTV.AthanTV";
                }
                if (window.tizen.ApplicationControl) {
                    try {
                        notificationDict.appControl = new window.tizen.ApplicationControl("http://tizen.org/appcontrol/operation/default");
                    } catch (ignore) {}
                }
                var notification = new window.tizen.StatusNotification("SIMPLE", title, notificationDict);
                window.tizen.notification.post(notification);
            }
        } catch (error) {
            /* not available on every Tizen version */
        }
        try {
            if (window.Notification && window.Notification.permission === "granted") {
                new window.Notification(title, { body: body, icon: "icon.png" });
            }
        } catch (error) {
            /* ignore */
        }
    }

    function requestNotificationPermission() {
        try {
            if (window.Notification && window.Notification.permission === "default") {
                window.Notification.requestPermission();
            }
        } catch (error) {
            /* ignore */
        }
    }

    function unlockOnInteraction() {
        function once() {
            ensureAudio();
            var player = $("adhan-player");
            if (player) {
                try {
                    player.load();
                } catch (ignore) {}
            }
            requestNotificationPermission();
            document.removeEventListener("keydown", once);
            document.removeEventListener("mousedown", once);
            document.removeEventListener("touchstart", once);
        }
        document.addEventListener("keydown", once);
        document.addEventListener("mousedown", once);
        document.addEventListener("touchstart", once);
    }

    /* ----------------------------- toast ----------------------------- */

    function showToast(title, text, duration) {
        $("toast-title").textContent = title;
        $("toast-text").textContent = text || "";
        $("toast").classList.remove("hidden");
        clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(function () {
            $("toast").classList.add("hidden");
        }, duration || 9000);
    }

    function hideToast() {
        clearTimeout(state.toastTimer);
        $("toast").classList.add("hidden");
    }

    /* ----------------------------- screens --------------------------- */

    function applyLanguage() {
        document.documentElement.lang = state.language;

        $$("[data-i18n]").forEach(function (element) {
            element.textContent = t(element.getAttribute("data-i18n"));
        });

        var searchInput = $("mosque-search");
        if (searchInput) {
            searchInput.placeholder = t("searchPlaceholder");
        }
        var countryFilter = $("country-filter");
        if (countryFilter) {
            countryFilter.placeholder = t("countryFilterPlaceholder");
        }

        var langButton = $("btn-lang-setup");
        if (langButton) {
            langButton.textContent = state.language === "fr" ? "EN" : "FR";
        }

        var about = $("about-line");
        if (about) {
            about.textContent = "Athan TV · v1.1.2";
        }

        updateSettingsUi();
        updateNetFooter();
        updateDashStatusLabel();
        updateCountryToggle();
        updateSearchSubtitle();

        // Transient action results were rendered in the previous language.
        setStatus("connect-status", "", "");
        setStatus("settings-test-status", "", "");
        if (state.setupStep === 3) {
            if (state.searchTotal === null) {
                setStatus("search-status", t("searchEmptyHint"), "");
            } else if (state.searchTotal > 0) {
                setStatus("search-status", tpl("resultsCount", { n: state.searchTotal }), "ok");
            } else {
                setStatus("search-status", t("noResults"), "");
            }
        }

        if (state.countries.length) {
            renderCountries();
        }
        if (state.overview) {
            renderDashboard();
        }
    }

    function setSetupStep(step) {
        state.setupStep = step;
        var index;
        for (index = 1; index <= 3; index++) {
            var section = $("setup-step-" + index);
            if (section) {
                section.className = "setup-step" + (index === step ? "" : " hidden");
            }
        }
        $$(".step").forEach(function (element) {
            var number = parseInt(element.getAttribute("data-step"), 10);
            element.classList.toggle("active", number === step);
            element.classList.toggle("done", number < step);
        });

        if (step === 1) {
            TvNav.focus($("btn-start"));
        } else if (step === 2) {
            renderCountries();
            updateCountryToggle();
            TvNav.focus($("country-filter"));
        } else if (step === 3) {
            updateSearchSubtitle();
            state.searchTotal = null;
            $("mosque-results").innerHTML = "";
            setStatus("search-status", t("searchEmptyHint"), "");
            TvNav.focus($("mosque-search"));
        }
        updateNetFooter();
    }

    function showSetup(step) {
        state.screen = "setup";
        stopTicker();
        $("screen-setup").classList.remove("hidden");
        $("screen-dashboard").classList.add("hidden");
        closeOverlays();
        setSetupStep(step || 1);
    }

    function showDashboard() {
        state.screen = "dashboard";
        $("screen-setup").classList.add("hidden");
        $("screen-dashboard").classList.remove("hidden");
        closeOverlays();
        renderDashboard();
        if (!state.overview) {
            setDashStatus("loading", "pending");
            renderDashboardEmpty();
        }
        TvNav.focus($("btn-settings"));
    }

    /* ---------------------------- countries -------------------------- */

    function loadCountries() {
        state.countries = window.MawaqitData.countries();
        renderCountries();
        updateCountryToggle();
        return state.countries;
    }

    function renderCountries() {
        var grid = $("country-grid");
        if (!grid) {
            return;
        }
        var filterInput = $("country-filter");
        var filter = normalizeText(filterInput ? filterInput.value : "");
        var list = state.countries.slice();

        if (filter) {
            list = list.filter(function (country) {
                return normalizeText(country.code).indexOf(filter) !== -1 ||
                    normalizeText(country.name && country.name.en).indexOf(filter) !== -1 ||
                    normalizeText(country.name && country.name.fr).indexOf(filter) !== -1;
            }).slice(0, 60);
        } else if (!state.showAllCountries) {
            list = list.slice(0, 30);
        }

        grid.innerHTML = "";

        if (!list.length) {
            var empty = document.createElement("div");
            empty.className = "status-line";
            empty.textContent = t("noCountries");
            grid.appendChild(empty);
            return;
        }

        list.forEach(function (country) {
            var button = document.createElement("button");
            button.className = "country-chip focusable";
            button.setAttribute("data-code", country.code);

            var name = document.createElement("span");
            name.textContent = countryName(country);
            button.appendChild(name);

            if (country.count) {
                var count = document.createElement("span");
                count.className = "chip-count";
                count.textContent = country.count;
                button.appendChild(count);
            }

            button.addEventListener("click", function () {
                selectCountry(country);
            });
            grid.appendChild(button);
        });
    }

    function updateCountryToggle() {
        var button = $("btn-toggle-all");
        var filterInput = $("country-filter");
        if (!button) {
            return;
        }
        if (filterInput && filterInput.value.trim()) {
            button.classList.add("hidden");
            return;
        }
        button.classList.remove("hidden");
        button.textContent = state.showAllCountries ? t("showLess") : t("showAll");
    }

    function selectCountry(country) {
        state.country = country;
        setSetupStep(3);
    }

    function updateSearchSubtitle() {
        var subtitle = $("search-subtitle");
        if (!subtitle) {
            return;
        }
        subtitle.textContent = state.country ? t("countryLabel") + ": " + countryName(state.country) : "";
    }

    /* ------------------------------ search --------------------------- */

    function performSearch() {
        var input = $("mosque-search");
        var query = input ? input.value.trim() : "";
        if (query.length < 2) {
            setStatus("search-status", t("searchMin"), "error");
            return;
        }
        if (!state.country) {
            setStatus("search-status", t("chooseCountry"), "error");
            return;
        }

        setStatus("search-status", t("searching"), "pending");
        state.searchTotal = null;
        $("mosque-results").innerHTML = "";

        window.MawaqitData.search(state.country.code, query).then(function (payload) {
            netOk();
            state.searchTotal = payload.total || 0;
            renderMosqueResults(payload.results || []);
            setStatus("search-status", tpl("resultsCount", { n: payload.total || 0 }), "ok");
        }).catch(function (error) {
            netError();
            state.searchTotal = null;
            setStatus("search-status", t("searchError") + " " + errorText(error), "error");
        });
    }

    function renderMosqueResults(results) {
        var container = $("mosque-results");
        container.innerHTML = "";

        if (!results.length) {
            setStatus("search-status", t("noResults"), "");
            return;
        }

        results.forEach(function (result) {
            var button = document.createElement("button");
            button.className = "mosque-result focusable";

            var logo = document.createElement("div");
            logo.className = "result-logo";
            var fallback = document.createElement("span");
            fallback.className = "result-fallback";
            fallback.textContent = "☪";
            logo.appendChild(fallback);
            if (result.image) {
                var image = document.createElement("img");
                image.alt = "";
                image.src = result.image;
                image.addEventListener("error", function () {
                    image.style.display = "none";
                });
                logo.appendChild(image);
            }

            var info = document.createElement("div");
            info.className = "result-info";

            var name = document.createElement("div");
            name.className = "result-name";
            name.textContent = result.displayName || result.name || result.slug;
            info.appendChild(name);

            if (result.name && /[\u0600-\u06FF]/.test(result.name) && result.name !== name.textContent) {
                var arabic = document.createElement("div");
                arabic.className = "result-arabic arabic";
                arabic.dir = "rtl";
                arabic.textContent = result.name;
                info.appendChild(arabic);
            }

            var addressParts = [];
            if (result.city) {
                addressParts.push(result.city);
            }
            if (result.zipcode) {
                addressParts.push(result.zipcode);
            }
            if (result.address) {
                addressParts.push(result.address);
            }
            var address = document.createElement("div");
            address.className = "result-addr";
            address.textContent = addressParts.join(" · ");
            info.appendChild(address);

            var go = document.createElement("div");
            go.className = "result-go";
            go.textContent = "›";

            button.appendChild(logo);
            button.appendChild(info);
            button.appendChild(go);
            button.addEventListener("click", function () {
                chooseMosque(result);
            });

            container.appendChild(button);
        });

        // Do NOT auto-focus the first result after search -- the Enter key event
        // is still propagating and would immediately click (select) it.
        // The user can press Down-arrow to move into the results list.
    }

    function chooseMosque(result) {
        state.mosque = {
            slug: result.slug,
            name: result.name || result.displayName || result.slug,
            displayName: result.displayName || result.name || result.slug,
            city: result.city || "",
            zipcode: result.zipcode || "",
            address: result.address || "",
            image: result.image || "",
            country: result.country || (state.country ? state.country.code : ""),
            countryName: state.country ? countryName(state.country) : (result.countryFullName || "")
        };
        state.overview = null;
        state.overviewFetchedAt = 0;
        state.lastAdhanKey = "";
        state.lastPreKey = "";
        saveState();
        showDashboard();
        refreshOverview(true, true);
    }

    /* ----------------------------- overview -------------------------- */

    function refreshOverview(showLoading, force) {
        if (!state.mosque || state.refreshing) {
            return;
        }
        state.refreshing = true;
        if (showLoading) {
            setDashStatus("loading", "pending");
        }

        var slug = state.mosque.slug;
        window.MawaqitData.overview(slug, !!force).then(function (payload) {
            if (!state.mosque || state.mosque.slug !== slug) {
                return;
            }
            state.overview = payload;
            state.overviewFetchedAt = Date.now();
            state.skewMs = Date.now() - Date.parse(payload.now.utc);
            state.lastRefreshAt = Date.now();
            saveState();
            renderDashboard();
            setDashStatus("live", "ok");
            netOk();
        }).catch(function () {
            state.lastRefreshAt = Date.now();
            netError();
            if (!state.overview) {
                setDashStatus("offline", "error");
                renderDashboardEmpty();
            } else {
                setDashStatus("offlineCache", "warn");
            }
        })["finally"](function () {
            // Always reset refreshing flag - even if catch itself threw.
            state.refreshing = false;
        });
    }

    function renderDashboardEmpty() {
        var mosque = state.mosque || {};
        $("mosque-name").textContent = mosque.displayName || mosque.name || mosque.slug || "Athan TV";
        $("mosque-city").textContent = [mosque.city, mosque.zipcode].filter(Boolean).join(" · ");
        $("mosque-arabic").textContent = "";
        $("next-name").textContent = "—";
        $("next-adhan").textContent = "--:--";
        $("next-iqama").textContent = "—";
        $("next-countdown").textContent = "--:--:--";
        $("prayer-grid").innerHTML = "";
        $("jumua-bar").classList.add("hidden");
        $("ticker").classList.add("hidden");
        $("clock-time").textContent = "--:--";
        $("clock-date").textContent = "";
        $("clock-hijri").textContent = "";
        $("dash-updated").textContent = "";
        $("dash-tz").textContent = "";
    }

    function renderDashboard() {
        var overview = state.overview;
        if (!overview) {
            renderDashboardEmpty();
            return;
        }

        var mosque = overview.mosque || {};
        var selected = state.mosque || {};

        $("mosque-name").textContent = selected.displayName || mosque.displayName || mosque.name || selected.slug || "Athan TV";
        $("mosque-city").textContent = [selected.city, selected.zipcode].filter(Boolean).join(" · ");

        var arabicName = mosque.name && /[\u0600-\u06FF]/.test(mosque.name) ? mosque.name : "";
        $("mosque-arabic").textContent = arabicName;

        var logo = $("mosque-logo");
        var logoSrc = selected.image || mosque.image || mosque.logo || "";
        logo.classList.remove("loaded");
        logo.onload = function () {
            logo.classList.add("loaded");
        };
        logo.onerror = function () {
            logo.classList.remove("loaded");
        };
        if (logoSrc) {
            logo.src = logoSrc;
            if (logo.complete && logo.naturalWidth > 0) {
                logo.classList.add("loaded");
            }
        } else {
            logo.removeAttribute("src");
        }

        var date = overview.date || {};
        $("clock-date").textContent = (date.gregorianDisplay && (date.gregorianDisplay[state.language] || date.gregorianDisplay.en)) || "";
        $("clock-hijri").textContent = (date.hijri && date.hijri.formatted && (date.hijri.formatted[state.language] || date.hijri.formatted.en)) || "";

        var next = overview.next;
        if (next && next.key) {
            $("next-name").textContent = prayerName(next.key);
            $("next-adhan").textContent = next.adhan || "--:--";
            $("next-iqama").textContent = next.iqama || "—";
            $("next-day-badge").classList.toggle("hidden", next.day !== "tomorrow");
        } else {
            $("next-name").textContent = "—";
            $("next-adhan").textContent = "--:--";
            $("next-iqama").textContent = "—";
            $("next-day-badge").classList.add("hidden");
        }

        var grid = $("prayer-grid");
        grid.innerHTML = "";
        var nowMs = Date.now() - state.skewMs;
        var prayers = overview.prayers || [];

        prayers.forEach(function (prayer) {
            var card = document.createElement("div");
            card.className = "prayer-card";

            if (prayer.key === "shuruq") {
                card.classList.add("is-shuruq");
            }
            if (Date.parse(prayer.atUtc) <= nowMs) {
                card.classList.add("is-past");
            }
            if (next && next.day === "today" && next.key === prayer.key) {
                card.classList.add("is-next");
                card.classList.remove("is-past");
            }

            var icon = document.createElement("div");
            icon.className = "prayer-icon";
            icon.textContent = PRAYER_ICONS[prayer.key] || "✦";

            var name = document.createElement("div");
            name.className = "prayer-name";
            name.textContent = prayerName(prayer.key);

            var adhan = document.createElement("div");
            adhan.className = "prayer-adhan";
            adhan.textContent = prayer.adhan || "--:--";

            var iqama = document.createElement("div");
            iqama.className = "prayer-iqama";
            iqama.textContent = prayer.iqama ? t("iqama") + " " + prayer.iqama : "";

            card.appendChild(icon);
            card.appendChild(name);
            card.appendChild(adhan);
            card.appendChild(iqama);
            grid.appendChild(card);
        });

        var jumuaBar = $("jumua-bar");
        var jumuaTimes = $("jumua-times");
        var jumua = overview.jumua || [];
        jumuaTimes.innerHTML = "";
        if (jumua.length) {
            jumuaBar.classList.remove("hidden");
            jumua.forEach(function (entry, index) {
                var item = document.createElement("span");
                item.className = "jumua-item";
                var label = document.createElement("span");
                label.textContent = index === 0 ? t("jumua") : t("jumua") + " " + (index + 1);
                var time = document.createElement("strong");
                time.textContent = entry.time;
                item.appendChild(label);
                item.appendChild(time);
                jumuaTimes.appendChild(item);
            });
        } else {
            jumuaBar.classList.add("hidden");
        }

        var timezone = mosque.timezone || "";
        $("dash-tz").textContent = timezone;
        $("dash-updated").textContent = state.overviewFetchedAt ? tpl("updated", { time: mosqueTimeString(state.overviewFetchedAt) }) : "";

        updateClock();
        startTicker();
    }

    function updateClock() {
        if (!state.overview || !state.overview.now) {
            return;
        }
        var date = new Date((Date.now() - state.skewMs) + mosqueOffsetMs());
        $("clock-time").textContent = pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes());
    }

    /* ----------------------------- ticker ---------------------------- */

    function startTicker() {
        stopTicker();
        var list = (state.overview && state.overview.announcements) || [];
        var ticker = $("ticker");
        if (!list.length) {
            ticker.classList.add("hidden");
            return;
        }
        ticker.classList.remove("hidden");
        state.tickerIndex = 0;
        showTickerItem();
        state.tickerTimer = window.setInterval(function () {
            state.tickerIndex = (state.tickerIndex + 1) % list.length;
            showTickerItem();
        }, 9000);
    }

    function stopTicker() {
        if (state.tickerTimer) {
            clearInterval(state.tickerTimer);
            state.tickerTimer = null;
        }
    }

    function showTickerItem() {
        var list = (state.overview && state.overview.announcements) || [];
        if (!list.length) {
            return;
        }
        var item = list[state.tickerIndex % list.length];
        var text = item.title || "";
        if (item.content) {
            text += (text ? " — " : "") + item.content;
        }
        $("ticker-text").textContent = text;
    }

    /* ------------------------------ tick ----------------------------- */

    function updateOledDrift() {
        if (state.screen !== "dashboard") {
            return;
        }
        var dash = $("screen-dashboard");
        if (!dash) {
            return;
        }
        var nowSec = Math.floor(Date.now() / 1000);
        // Smooth 20-minute Lissajous drift (+/- 3px X, +/- 2px Y) to prevent OLED burn-in
        var phase = (2 * Math.PI * (nowSec % 1200)) / 1200;
        var dx = Math.round(3 * Math.sin(phase));
        var dy = Math.round(2 * Math.cos(phase * 2));
        dash.style.transform = "translate3d(" + dx + "px, " + dy + "px, 0)";
    }

    function tick() {
        if (state.screen === "dashboard") {
            updateClock();
            updateOledDrift();
        }
        if (!state.overview) {
            return;
        }

        var overview = state.overview;
        var correctedNow = Date.now() - state.skewMs;

        if (overview.next && overview.next.atUtc) {
            var remain = Date.parse(overview.next.atUtc) - correctedNow;
            if (state.screen === "dashboard") {
                $("next-countdown").textContent = formatCountdown(Math.max(0, remain));
            }
            handleTriggers(remain, correctedNow);
        }

        if (state.screen === "dashboard" && overview.date && overview.date.gregorian) {
            var currentDate = mosqueDateString(correctedNow);
            if (currentDate && currentDate !== overview.date.gregorian &&
                Date.now() - state.lastRefreshAt > 60000) {
                refreshOverview(false);
            }
        }

        updatePrayerOverlayCountdown(correctedNow);
    }

    function handleTriggers(remain, nowMs) {
        var next = state.overview.next;
        if (!next) {
            return;
        }
        var key = next.key + "@" + next.atUtc;
        var preMs = state.preAlertMinutes * 60 * 1000;

        // Do not announce a reminder when the adhan is less than a minute
        // away: the prayer overlay is about to take over the screen.
        if (preMs > 0 && remain > 60000 && remain <= preMs && state.lastPreKey !== key) {
            state.lastPreKey = key;
            showPreAlert(next, Math.max(1, Math.round(remain / 60000)));
        }

        var lateness = -remain;
        // Trigger only within 90 seconds of the actual adhan moment.
        // If launched later (e.g. 10 minutes past), do not interrupt with an alarm.
        if (remain <= 0 && state.lastAdhanKey !== key) {
            state.lastAdhanKey = key;
            saveState();
            if (lateness < 90 * 1000) {
                triggerPrayerNotification(next);
            }
            window.setTimeout(function () {
                refreshOverview(false);
            }, 90000);
        }
    }

    function triggerPrayerNotification(prayer) {
        var isBackground = !!(document.hidden || (document.visibilityState === "hidden"));
        var name = prayerName(prayer.key);

        if (isBackground) {
            // App is in background: post native Samsung Tizen notification with adhan sound
            sendNotification(
                tpl("notifPrayerTitle", { prayer: name, time: prayer.adhan }),
                tpl("notifPrayerBody", { mosque: mosqueLabel() }),
                "audio/adan.mp3"
            );
            // Also attempt to play the adhan audio directly if platform allows background audio
            playAdhanAudio();
        } else {
            // App is in foreground: show full-screen prayer modal takeover + play adhan
            showPrayerMoment(prayer);
        }
    }

    function showPreAlert(prayer) {
        var name = prayerName(prayer.key);
        showToast(tpl("preAlertTitle", { n: state.preAlertMinutes }),
            tpl("preAlertBody", { prayer: name, time: prayer.adhan }), 12000);
        playChime(false);
        sendNotification(tpl("notifPreTitle", { n: state.preAlertMinutes }),
            tpl("notifPreBody", { prayer: name, time: prayer.adhan }));
        saveState();
    }

    function showPrayerMoment(prayer) {
        var name = prayerName(prayer.key);
        state.prayerOverlayIqamaAt = prayer.iqamaAtUtc || "";
        state.prayerOverlayIqamaText = prayer.iqama ? t("iqama") + " " + prayer.iqama : "";

        $("overlay-prayer-name").textContent = name;
        $("overlay-prayer-time").textContent = prayer.adhan || "--:--";
        $("overlay-mosque").textContent = mosqueLabel();
        $("overlay-iqama").textContent = state.prayerOverlayIqamaText;

        openOverlay("prayer");
        playAdhanAudio();
        speak(tpl("speechPrayer", { prayer: name }));
        sendNotification(tpl("notifPrayerTitle", { prayer: name, time: prayer.adhan }),
            tpl("notifPrayerBody", { mosque: mosqueLabel() }));

        clearTimeout(state.overlayTimer);
        state.overlayTimer = window.setTimeout(function () {
            if (state.overlay === "prayer") {
                closeOverlays();
            }
        }, 90000);

        updatePrayerOverlayCountdown(Date.now() - state.skewMs);
    }

    function updatePrayerOverlayCountdown(nowMs) {
        if (state.overlay !== "prayer" || !state.prayerOverlayIqamaAt) {
            return;
        }
        var remain = Date.parse(state.prayerOverlayIqamaAt) - nowMs;
        if (remain > 0) {
            $("overlay-iqama").textContent = tpl("iqamaIn", { t: formatCountdown(remain) });
        } else if (remain > -60000) {
            $("overlay-iqama").textContent = t("iqamaNow");
        } else {
            $("overlay-iqama").textContent = state.prayerOverlayIqamaText;
        }
    }

    /* ---------------------------- overlays --------------------------- */

    function activeScope() {
        if (state.overlay === "settings") {
            return $("overlay-settings");
        }
        if (state.overlay === "prayer") {
            return $("overlay-prayer");
        }
        if (state.screen === "setup") {
            return $("screen-setup");
        }
        return $("screen-dashboard");
    }

    function openOverlay(name) {
        state.overlay = name;
        var element = name === "settings" ? $("overlay-settings") : $("overlay-prayer");
        if (element) {
            element.classList.remove("hidden");
        }
        var focusable = TvNav.focusables(element);
        if (focusable.length) {
            TvNav.focus(focusable[0]);
        }
    }

    function closeOverlays() {
        state.overlay = null;
        $("overlay-settings").classList.add("hidden");
        $("overlay-prayer").classList.add("hidden");
        clearTimeout(state.overlayTimer);
        stopAdhanAudio();
        if (state.screen === "dashboard") {
            TvNav.focus($("btn-settings"));
        }
    }

    /* ---------------------------- settings --------------------------- */

    function updateSettingsUi() {
        $$("[data-lang]").forEach(function (button) {
            button.classList.toggle("is-active", button.getAttribute("data-lang") === state.language);
        });

        var notifications = $("toggle-notifications");
        if (notifications) {
            notifications.textContent = t(state.notifications ? "on" : "off");
            notifications.classList.toggle("is-active", state.notifications);
        }

        var sound = $("toggle-sound");
        if (sound) {
            sound.textContent = t(state.sound ? "on" : "off");
            sound.classList.toggle("is-active", state.sound);
        }

        var voice = $("toggle-voice");
        if (voice) {
            voice.textContent = t(state.voice ? "on" : "off");
            voice.classList.toggle("is-active", state.voice);
        }

        $$("#prealert-seg [data-pre]").forEach(function (button) {
            var value = parseInt(button.getAttribute("data-pre"), 10);
            button.classList.toggle("is-active", value === state.preAlertMinutes);
        });
    }

    function openSettings() {
        setStatus("settings-test-status", "", "");
        var changeButton = $("btn-change-mosque");
        if (changeButton) {
            changeButton.classList.toggle("hidden", !state.mosque);
        }
        var reloadButton = $("btn-reload");
        if (reloadButton) {
            reloadButton.classList.toggle("hidden", !state.mosque);
        }
        updateSettingsUi();
        openOverlay("settings");
        var initial = document.querySelector('#overlay-settings [data-lang].is-active') ||
            $("btn-close-settings");
        TvNav.focus(initial);
    }

    function setLanguage(language) {
        if (language !== "fr" && language !== "en") {
            return;
        }
        state.language = language;
        saveState();
        applyLanguage();
    }

    function toggleSetting(name) {
        state[name] = !state[name];
        if (name === "notifications" && state.notifications) {
            requestNotificationPermission();
        }
        saveState();
        updateSettingsUi();
    }

    function testConnection() {
        setStatus("settings-test-status", t("connectionTesting"), "pending");
        state.netStatus = "pending";
        updateNetFooter();
        window.MawaqitData.ping().then(function () {
            netOk();
            setStatus("settings-test-status", t("connectionOk"), "ok");
        }).catch(function (error) {
            netError();
            setStatus("settings-test-status", t("connectionError") + " " + errorText(error), "error");
        });
    }

    function changeMosque() {
        closeOverlays();
        // If a country is already selected, jump straight to mosque search (step 3).
        // The user can still go back to step 2 to change country if needed.
        showSetup(state.country ? 3 : 2);
    }

    /* ---------------------------- connection ------------------------- */

    function startSetup() {
        state.netStatus = "unknown";
        setStatus("connect-status", "", "");
        updateNetFooter();
        setSetupStep(2);
    }

    function testSetupConnection() {
        setStatus("connect-status", t("connectionTesting"), "pending");
        state.netStatus = "pending";
        updateNetFooter();
        window.MawaqitData.ping().then(function () {
            netOk();
            setStatus("connect-status", t("connectionOk"), "ok");
        }).catch(function (error) {
            netError();
            setStatus("connect-status", t("connectionError") + " " + errorText(error), "error");
        });
    }

    /* --------------------------- keyboard ---------------------------- */

    function isTextInput(element) {
        if (!element) {
            return false;
        }
        var tag = element.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    function handleInputEnter(input) {
        var id = input.id;
        if (id === "mosque-search") {
            performSearch();
        } else if (id === "country-filter") {
            var first = $("country-grid").querySelector(".country-chip");
            if (first) {
                TvNav.focus(first);
            }
        }
    }

    function handleBack() {
        if (state.overlay) {
            closeOverlays();
            return true;
        }
        if (state.screen === "setup") {
            if (state.setupStep > 1) {
                setSetupStep(state.setupStep - 1);
                return true;
            }
            if (state.mosque) {
                showDashboard();
                return true;
            }
            return false;
        }
        return false;
    }

    function onKeyDown(event) {
        var code = event.keyCode || event.which;

        // The prayer moment is modal: OK/Back dismiss it and nothing behind it
        // may receive the key press.
        if (state.overlay === "prayer") {
            if (code === 13 || code === 10009 || code === 461 || code === 27) {
                event.preventDefault();
                closeOverlays();
            } else if (code >= 37 && code <= 40) {
                event.preventDefault();
            }
            return;
        }

        if (code === 10009 || code === 461 || code === 27) {
            if (handleBack()) {
                event.preventDefault();
            }
            return;
        }

        if (code === 13) {
            var active = document.activeElement;
            if (isTextInput(active)) {
                event.preventDefault();
                handleInputEnter(active);
                return;
            }
            if (active && active.click && active.tagName === "BUTTON") {
                event.preventDefault();
                active.click();
                return;
            }
            return;
        }

        if (code >= 37 && code <= 40) {
            var focused = document.activeElement;

            // Text fields keep the cursor keys for editing, but TV users still
            // need a predictable way to reach the action next to the field.
            if (isTextInput(focused)) {
                if (code === 37) {
                    return;
                }
                if (code === 39) {
                    if (focused.id === "mosque-search") {
                        event.preventDefault();
                        TvNav.focus($("btn-search"));
                        return;
                    }
                    return;
                }
                if (code === 40) {
                    if (focused.id === "country-filter") {
                        var firstCountry = $("country-grid").querySelector(".country-chip");
                        if (firstCountry) {
                            event.preventDefault();
                            TvNav.focus(firstCountry);
                            return;
                        }
                    }
                    if (focused.id === "mosque-search") {
                        var firstResult = $("mosque-results").querySelector(".mosque-result");
                        event.preventDefault();
                        TvNav.focus(firstResult || $("btn-search"));
                        return;
                    }
                }
            }

            event.preventDefault();
            TvNav.move(activeScope(), code);
        }
    }

    /* ----------------------------- bind ------------------------------ */

    function bindEvents() {
        $("btn-start").addEventListener("click", startSetup);
        $("btn-test-connection").addEventListener("click", testSetupConnection);

        $("country-filter").addEventListener("input", function () {
            renderCountries();
            updateCountryToggle();
        });

        $("btn-toggle-all").addEventListener("click", function () {
            state.showAllCountries = !state.showAllCountries;
            renderCountries();
            updateCountryToggle();
        });

        $("btn-back-2").addEventListener("click", function () {
            setSetupStep(1);
        });
        $("btn-back-3").addEventListener("click", function () {
            setSetupStep(2);
        });

        $("btn-search").addEventListener("click", performSearch);
        // Enter on mosque-search handled by global onKeyDown -> handleInputEnter.
        // Duplicate inline listener removed to prevent double-search on keypress.

        $("btn-lang-setup").addEventListener("click", function () {
            setLanguage(state.language === "fr" ? "en" : "fr");
        });
        $("btn-settings-setup").addEventListener("click", openSettings);

        $("btn-refresh").addEventListener("click", function () {
            refreshOverview(true, true);
        });
        $("btn-settings").addEventListener("click", openSettings);
        $("btn-close-settings").addEventListener("click", closeOverlays);

        $$("[data-lang]").forEach(function (button) {
            button.addEventListener("click", function () {
                setLanguage(button.getAttribute("data-lang"));
            });
        });

        $("toggle-notifications").addEventListener("click", function () {
            toggleSetting("notifications");
        });
        $("toggle-sound").addEventListener("click", function () {
            toggleSetting("sound");
        });
        $("toggle-voice").addEventListener("click", function () {
            toggleSetting("voice");
        });

        $$("#prealert-seg [data-pre]").forEach(function (button) {
            button.addEventListener("click", function () {
                state.preAlertMinutes = parseInt(button.getAttribute("data-pre"), 10);
                saveState();
                updateSettingsUi();
            });
        });

        $("btn-test-sound").addEventListener("click", function () {
            ensureAudio();
            if (isAdhanPlaying()) {
                stopAdhanAudio();
            } else {
                playAdhanAudio();
            }
        });

        $("btn-test-api").addEventListener("click", testConnection);

        $("btn-change-mosque").addEventListener("click", changeMosque);
        $("btn-reload").addEventListener("click", function () {
            refreshOverview(true, true);
        });

        $("toast").addEventListener("click", hideToast);

        document.addEventListener("keydown", onKeyDown);
    }

    function onVisibilityChange() {
        if (!document.hidden && document.visibilityState !== "hidden") {
            if (state.screen === "dashboard" && !state.refreshing &&
                Date.now() - state.lastRefreshAt > 60000) {
                refreshOverview(false);
            }
        }
    }

    /* ------------------------------ init ----------------------------- */

    function init() {
        loadState();
        loadCountries();
        bindEvents();
        applyLanguage();
        unlockOnInteraction();

        if (state.mosque) {
            showDashboard();
            refreshOverview(!state.overview);
        } else {
            showSetup(1);
        }

        window.setInterval(tick, 1000);
        window.setInterval(function () {
            if (state.screen === "dashboard" && Date.now() - state.lastRefreshAt > REFRESH_INTERVAL) {
                refreshOverview(false);
            }
        }, 60000);

        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("focus", onVisibilityChange);
        window.addEventListener("online", function () {
            if (state.screen === "dashboard") {
                refreshOverview(false);
            }
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
