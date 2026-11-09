(function () {
    "use strict";

    var SELECTOR = 'button, input, select, textarea, [tabindex="0"]';
    var EPSILON = 8;

    function isVisible(element) {
        if (!element || element.disabled) {
            return false;
        }
        if (element.offsetParent === null) {
            return false;
        }
        var rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function focusables(container) {
        var root = container || document;
        var nodes = root.querySelectorAll(SELECTOR);
        var result = [];
        for (var i = 0; i < nodes.length; i++) {
            if (isVisible(nodes[i])) {
                result.push(nodes[i]);
            }
        }
        return result;
    }

    function center(element) {
        var rect = element.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };
    }

    function focus(element) {
        if (!element) {
            return;
        }
        try {
            element.focus();
        } catch (ignore) {
            /* older browsers */
        }
        try {
            element.scrollIntoView({ block: "nearest", inline: "nearest" });
        } catch (error) {
            try {
                element.scrollIntoView();
            } catch (ignore) {
                /* nothing else we can do */
            }
        }
    }

    function rectOf(element) {
        return element.getBoundingClientRect();
    }

    function overlapsX(a, b) {
        return a.left < b.right - EPSILON && b.left < a.right - EPSILON;
    }

    function overlapsY(a, b) {
        return a.top < b.bottom - EPSILON && b.top < a.bottom - EPSILON;
    }

    function move(container, keyCode) {
        var items = focusables(container);
        if (!items.length) {
            return null;
        }

        var current = document.activeElement;
        if (items.indexOf(current) === -1) {
            focus(items[0]);
            return items[0];
        }

        var origin = center(current);
        var originRect = rectOf(current);
        var horizontal = keyCode === 37 || keyCode === 39;
        var candidates = [];

        for (var i = 0; i < items.length; i++) {
            var element = items[i];
            if (element === current) {
                continue;
            }

            var point = center(element);
            var dx = point.x - origin.x;
            var dy = point.y - origin.y;
            var primary;
            var secondary;

            if (keyCode === 37) {
                if (dx > -EPSILON) {
                    continue;
                }
                primary = -dx;
                secondary = Math.abs(dy);
            } else if (keyCode === 39) {
                if (dx < EPSILON) {
                    continue;
                }
                primary = dx;
                secondary = Math.abs(dy);
            } else if (keyCode === 38) {
                if (dy > -EPSILON) {
                    continue;
                }
                primary = -dy;
                secondary = Math.abs(dx);
            } else if (keyCode === 40) {
                if (dy < EPSILON) {
                    continue;
                }
                primary = dy;
                secondary = Math.abs(dx);
            } else {
                return null;
            }

            candidates.push({
                element: element,
                primary: primary,
                secondary: secondary,
                aligned: horizontal
                    ? overlapsY(originRect, rectOf(element))
                    : overlapsX(originRect, rectOf(element))
            });
        }

        if (!candidates.length) {
            return null;
        }

        // Prefer controls that share the current row (left/right) or column
        // (up/down), so a D-pad press does not jump diagonally across the grid.
        var aligned = candidates.filter(function (candidate) {
            return candidate.aligned;
        });
        var pool = aligned.length ? aligned : candidates;

        var best = null;
        var bestScore = Infinity;
        var weight = aligned.length ? 0.25 : (horizontal ? 6 : 0.8);

        for (var j = 0; j < pool.length; j++) {
            var score = pool[j].primary + pool[j].secondary * weight;
            if (score < bestScore) {
                bestScore = score;
                best = pool[j].element;
            }
        }

        if (best) {
            focus(best);
            return best;
        }
        return null;
    }

    window.TvNav = {
        focusables: focusables,
        focus: focus,
        move: move,
        isVisible: isVisible
    };
})();
