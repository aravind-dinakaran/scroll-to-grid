(function () {
    "use strict";

    const LOG_PREFIX = "[Monetate Dynamic Scroll]";
    const TARGET_PARAM = "scrollToGridId";
    const DEBUG_PARAM = "scrollDebug";
    const OFFSET_PARAM = "scrollToGridOffset";
    const ADJUST_DELAY_PARAM = "scrollToGridAdjustDelay";

    const MAX_WAIT_TIME = 10000;
    const REQUIRED_STABLE_TIME = 900;
    const MIN_OBSERVE_TIME = 1500;
    const POSITION_TOLERANCE = 2;
    const CHECK_INTERVAL = 100;
    const SCROLL_IDLE_TIME = 180;
    const POSITION_ERROR_SETTLE_TIME = 250;
    // Wait after the first jump so sticky/floating PLP chrome can finish
    // animating before corrective scrolls start fighting it.
    const DEFAULT_POST_INITIAL_SCROLL_DELAY = 600;

    // Academy next-gen header slides in on upward scroll via #headerForScroll
    // inside #nextGenHeader240. Always reserve its settled height, but never
    // chase the slide-in animation as a live sticky offset.
    const FLOATING_HEADER_ID = "nextGenHeader240";
    const FLOATING_HEADER_SCROLL_ID = "headerForScroll";
    const FLOATING_HEADER_HEIGHT = 248;

    const ALLOWED_TARGET_IDS = [
        "filterBarStickyArea",
        "wrapperProductGrid",
        "productGrid"
    ];

    const STICKY_OFFSET_SELECTORS = [
        "header",
        "[role='banner']",
        "[data-testid*='header']",
        "[data-auid*='header']",
        "#filterBarStickyArea [class*='quickFilterBar']",
        "[class*='sticky']",
        "[class*='Sticky']",
        "[class*='fixed']",
        "[class*='Fixed']"
    ];

    const params = new URLSearchParams(window.location.search);
    const DEBUG = params.get(DEBUG_PARAM) === "true";
    const targetId = getRequestedTargetId();
    const manualOffset = getManualOffset();
    const postInitialScrollDelay = getPostInitialScrollDelay();
    const startTime = now();

    let active = false;
    let cancelled = false;
    let target = null;
    let waitObserver = null;
    let mutationObserver = null;
    let resizeObserver = null;
    let layoutShiftObserver = null;
    let rafId = null;
    let checkIntervalId = null;
    let timeoutId = null;
    let delayedCheckTimeoutId = null;
    let adjustDelayTimeoutId = null;
    let stableSince = null;
    let pendingCorrection = null;
    let lastScrollActivityAt = 0;
    let correctionCount = 0;
    let initialScrollCompletedAt = null;
    let adjustmentsEnabled = false;

    log("Script initialized.", {
        url: window.location.href,
        targetId,
        debugEnabled: DEBUG,
        postInitialScrollDelay
    });

    if (!targetId) {
        log("No allowed scroll target was requested.");
        return;
    }

    if (window.__dynamicScrollTargetActive) {
        warn("A dynamic scroll process is already active. Duplicate execution stopped.");
        return;
    }

    window.__dynamicScrollTargetActive = true;
    active = true;

    addUserCancelListeners();
    waitForTarget();

    function getRequestedTargetId() {
        const requestedId = normalizeTargetId(
            params.get(TARGET_PARAM) || getHashTargetId()
        );

        if (!requestedId) {
            return null;
        }

        if (ALLOWED_TARGET_IDS.indexOf(requestedId) === -1) {
            warn("Target ID is not in the allowed target list.", {
                requestedId,
                allowedTargetIds: ALLOWED_TARGET_IDS
            });
            return null;
        }

        return requestedId;
    }

    function normalizeTargetId(value) {
        if (!value) {
            return null;
        }

        return String(value).replace(/^#/, "").trim();
    }

    function getHashTargetId() {
        const hash = window.location.hash;

        if (!hash || hash.indexOf(":~:text=") !== -1) {
            return null;
        }

        try {
            return decodeURIComponent(hash.slice(1));
        } catch (caughtError) {
            warn("Unable to decode URL hash.", caughtError);
            return hash.slice(1);
        }
    }

    function getManualOffset() {
        const rawOffset = params.get(OFFSET_PARAM);

        if (rawOffset === null) {
            return null;
        }

        const parsedOffset = Number(rawOffset);

        if (!Number.isFinite(parsedOffset)) {
            warn("Ignoring invalid manual scroll offset.", {
                rawOffset
            });
            return null;
        }

        return Math.max(0, parsedOffset);
    }

    function getPostInitialScrollDelay() {
        const rawDelay = params.get(ADJUST_DELAY_PARAM);

        if (rawDelay === null) {
            return DEFAULT_POST_INITIAL_SCROLL_DELAY;
        }

        const parsedDelay = Number(rawDelay);

        if (!Number.isFinite(parsedDelay) || parsedDelay < 0) {
            warn("Ignoring invalid post-initial scroll adjust delay.", {
                rawDelay,
                fallback: DEFAULT_POST_INITIAL_SCROLL_DELAY
            });
            return DEFAULT_POST_INITIAL_SCROLL_DELAY;
        }

        return parsedDelay;
    }

    function waitForTarget() {
        target = document.getElementById(targetId);

        if (target) {
            log("Target element found.", {
                targetId,
                elapsedTime: elapsed()
            });
            startStabilization();
            return;
        }

        if (!document.documentElement) {
            scheduleFrame(waitForTarget);
            return;
        }

        waitObserver = new MutationObserver(function () {
            target = document.getElementById(targetId);

            if (!target) {
                return;
            }

            log("Target element appeared in the client-rendered DOM.", {
                targetId,
                elapsedTime: elapsed()
            });

            disconnectWaitObserver();
            startStabilization();
        });

        waitObserver.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        timeoutId = window.setTimeout(function () {
            warn("Timed out while waiting for the target element.", {
                targetId,
                elapsedTime: elapsed()
            });
            cleanup("target-not-found-timeout");
        }, MAX_WAIT_TIME);

        log("Waiting for target element.", {
            targetId,
            maxWaitTime: MAX_WAIT_TIME
        });
    }

    function startStabilization() {
        if (!active || cancelled) {
            return;
        }

        window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(function () {
            finalCorrection("stabilization-timeout");
        }, Math.max(0, MAX_WAIT_TIME - elapsed()));

        observeLayoutChanges();

        checkIntervalId = window.setInterval(function () {
            scheduleCheck("interval-check");
        }, CHECK_INTERVAL);

        log("Scroll stabilization started.", {
            targetId,
            maxWaitTime: MAX_WAIT_TIME,
            requiredStableTime: REQUIRED_STABLE_TIME,
            minObserveTime: MIN_OBSERVE_TIME,
            positionTolerance: POSITION_TOLERANCE,
            scrollIdleTime: SCROLL_IDLE_TIME,
            positionErrorSettleTime: POSITION_ERROR_SETTLE_TIME,
            postInitialScrollDelay,
            manualOffset
        });

        scrollToTarget("initial-scroll");
        beginPostInitialScrollDelay();
    }

    function beginPostInitialScrollDelay() {
        initialScrollCompletedAt = now();
        adjustmentsEnabled = postInitialScrollDelay <= 0;

        if (adjustmentsEnabled) {
            log("Post-initial scroll delay skipped; adjustments enabled immediately.");
            scheduleCheck("after-initial-scroll");
            return;
        }

        log("Deferring scroll adjustments after initial scroll.", {
            postInitialScrollDelay
        });

        window.clearTimeout(adjustDelayTimeoutId);
        adjustDelayTimeoutId = window.setTimeout(function () {
            adjustDelayTimeoutId = null;

            if (!active || cancelled) {
                return;
            }

            adjustmentsEnabled = true;
            clearPendingCorrection("post-initial-scroll-delay-elapsed");
            resetStability("post-initial-scroll-delay-elapsed");

            log("Post-initial scroll delay elapsed; enabling adjustments.", {
                postInitialScrollDelay,
                elapsedTime: elapsed()
            });

            scheduleCheck("after-post-initial-scroll-delay");
        }, postInitialScrollDelay);
    }

    function getRemainingPostInitialScrollDelay() {
        if (adjustmentsEnabled || initialScrollCompletedAt === null) {
            return 0;
        }

        const waited = now() - initialScrollCompletedAt;
        return Math.max(0, postInitialScrollDelay - waited);
    }

    function observeLayoutChanges() {
        mutationObserver = new MutationObserver(function (mutations) {
            if (areFloatingHeaderOnlyMutations(mutations)) {
                return;
            }

            scheduleCheck("dom-mutation");
        });

        mutationObserver.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        if ("ResizeObserver" in window) {
            resizeObserver = new ResizeObserver(function (entries) {
                if (areFloatingHeaderOnlyResizeEntries(entries)) {
                    return;
                }

                scheduleCheck("resize");
            });

            observeIfElement(resizeObserver, document.documentElement);
            observeIfElement(resizeObserver, document.body);
            observeIfElement(resizeObserver, target);
            observeIfElement(resizeObserver, target && target.parentElement);
        } else {
            warn("ResizeObserver is not supported. Falling back to timed checks.");
        }

        if ("PerformanceObserver" in window) {
            try {
                layoutShiftObserver = new PerformanceObserver(function (entryList) {
                    const hasLayoutShift = entryList.getEntries().some(function (entry) {
                        if (entry.hadRecentInput) {
                            return false;
                        }

                        return !isFloatingHeaderOnlyLayoutShift(entry);
                    });

                    if (!hasLayoutShift) {
                        return;
                    }

                    scheduleCheck("layout-shift");
                });

                layoutShiftObserver.observe({
                    type: "layout-shift",
                    buffered: true
                });
            } catch (caughtError) {
                log("Layout Instability API is unavailable.", caughtError);
            }
        }

        window.addEventListener("load", scheduleLoadCheck, { once: true });
        window.addEventListener("scroll", scheduleScrollCheck, { passive: true });
        window.addEventListener("resize", scheduleResizeCheck, { passive: true });
        window.addEventListener("orientationchange", scheduleResizeCheck);

        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", scheduleResizeCheck, {
                passive: true
            });
            window.visualViewport.addEventListener("scroll", scheduleResizeCheck, {
                passive: true
            });
        }

        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () {
                scheduleCheck("fonts-ready");
            });
        }
    }

    function observeIfElement(observer, element) {
        if (element && element.nodeType === 1) {
            observer.observe(element);
        }
    }

    function scheduleLoadCheck() {
        scheduleCheck("window-load");
    }

    function scheduleResizeCheck() {
        markScrollActivity();
        scheduleCheck("viewport-change");
    }

    function scheduleScrollCheck() {
        markScrollActivity();
        scheduleCheck("scroll-activity");
    }

    function scheduleCheck(reason) {
        if (!active || cancelled || rafId !== null) {
            return;
        }

        rafId = window.requestAnimationFrame(function () {
            rafId = null;
            checkPosition(reason);
        });
    }

    function scheduleDelayedCheck(reason, delay) {
        if (!active || cancelled) {
            return;
        }

        window.clearTimeout(delayedCheckTimeoutId);
        delayedCheckTimeoutId = window.setTimeout(function () {
            delayedCheckTimeoutId = null;
            scheduleCheck(reason);
        }, Math.max(0, delay));
    }

    function scheduleFrame(callback) {
        rafId = window.requestAnimationFrame(function () {
            rafId = null;
            callback();
        });
    }

    function checkPosition(reason) {
        if (!active || cancelled) {
            return;
        }

        if (!target || !document.contains(target)) {
            target = document.getElementById(targetId);
            resetStability("target-replaced");
            clearPendingCorrection("target-replaced");

            if (!target) {
                if (elapsed() >= MAX_WAIT_TIME) {
                    cleanup("replacement-target-not-found");
                    return;
                }

                scheduleCheck("waiting-for-replacement-target");
                return;
            }

            if (resizeObserver) {
                observeIfElement(resizeObserver, target);
                observeIfElement(resizeObserver, target.parentElement);
            }

            log("Replacement target element found.", {
                targetId
            });
        }

        const desiredTop = getDesiredViewportTop(target);
        const currentTop = target.getBoundingClientRect().top;
        const positionError = Math.abs(currentTop - desiredTop);
        const remainingPostInitialDelay = getRemainingPostInitialScrollDelay();

        if (remainingPostInitialDelay > 0) {
            // Observe layout, but do not treat the target as stable until the
            // floating/sticky chrome has had time to settle after the jump.
            if (positionError > POSITION_TOLERANCE) {
                handlePositionError(reason, currentTop, desiredTop, positionError);
            } else {
                scheduleDelayedCheck(
                    "waiting-for-post-initial-scroll-delay",
                    remainingPostInitialDelay
                );
            }

            if (elapsed() >= MAX_WAIT_TIME) {
                finalCorrection("stabilization-timeout");
            }

            return;
        }

        if (positionError > POSITION_TOLERANCE) {
            handlePositionError(reason, currentTop, desiredTop, positionError);
            return;
        }

        clearPendingCorrection("position-within-tolerance");

        if (stableSince === null) {
            stableSince = now();
            log("Target entered stable position.", {
                currentTop,
                desiredTop
            });
        }

        const stableDuration = now() - stableSince;
        const oldEnough = elapsed() >= MIN_OBSERVE_TIME;

        if (oldEnough && stableDuration >= REQUIRED_STABLE_TIME) {
            finalCorrection("target-stabilized");
            return;
        }

        if (elapsed() >= MAX_WAIT_TIME) {
            finalCorrection("stabilization-timeout");
        }
    }

    function handlePositionError(reason, currentTop, desiredTop, positionError) {
        const currentTime = now();
        const remainingPostInitialDelay = getRemainingPostInitialScrollDelay();

        resetStability("position-out-of-tolerance");

        if (remainingPostInitialDelay > 0) {
            log("Position correction held for post-initial scroll delay.", {
                reason,
                currentTop,
                desiredTop,
                positionError,
                remainingPostInitialDelay
            });

            scheduleDelayedCheck(
                "waiting-for-post-initial-scroll-delay",
                remainingPostInitialDelay
            );
            return;
        }

        if (!pendingCorrection) {
            pendingCorrection = {
                firstDetectedAt: currentTime,
                maxPositionError: positionError
            };
        } else {
            pendingCorrection.maxPositionError = Math.max(
                pendingCorrection.maxPositionError,
                positionError
            );
        }

        const pendingDuration = currentTime - pendingCorrection.firstDetectedAt;
        const timeSinceScrollActivity = currentTime - lastScrollActivityAt;
        const timeUntilScrollIdle = Math.max(
            0,
            SCROLL_IDLE_TIME - timeSinceScrollActivity
        );
        const timeUntilErrorSettled = Math.max(
            0,
            POSITION_ERROR_SETTLE_TIME - pendingDuration
        );
        const delay = Math.max(timeUntilScrollIdle, timeUntilErrorSettled);

        if (delay > 0 && elapsed() + delay < MAX_WAIT_TIME) {
            log("Position correction deferred.", {
                reason,
                currentTop,
                desiredTop,
                positionError,
                pendingDuration,
                timeSinceScrollActivity,
                delay
            });

            scheduleDelayedCheck("deferred-position-correction", delay);
            return;
        }

        log("Target position requires correction.", {
            reason,
            currentTop,
            desiredTop,
            positionError,
            pendingDuration,
            maxPositionError: pendingCorrection.maxPositionError
        });

        clearPendingCorrection("position-correction");
        scrollToTarget("position-correction");
        scheduleDelayedCheck("after-position-correction", SCROLL_IDLE_TIME);
    }

    function scrollToTarget(reason) {
        if (!target) {
            warn("scrollToTarget was called without a valid target.");
            return;
        }

        const desiredTop = getDesiredViewportTop(target);
        const currentTop = target.getBoundingClientRect().top;
        const scrollTop = Math.max(
            0,
            window.scrollY + currentTop - desiredTop
        );

        markScrollActivity();
        correctionCount += 1;

        log("Scrolling to target.", {
            reason,
            targetId,
            correctionCount,
            currentScrollY: window.scrollY,
            targetViewportTop: currentTop,
            desiredViewportTop: desiredTop,
            calculatedScrollTop: scrollTop
        });

        window.scrollTo({
            top: scrollTop,
            behavior: "auto"
        });
    }

    function finalCorrection(reason) {
        // Allow the timeout path to correct even if the post-initial delay
        // has not fully elapsed, so we still land on target before cleanup.
        adjustmentsEnabled = true;
        scrollToTarget("final-" + reason);
        cleanup(reason);
    }

    function getDesiredViewportTop(element) {
        if (manualOffset !== null) {
            return manualOffset;
        }

        return Math.max(
            getStickyOffset(element),
            getScrollMarginTop(element)
        );
    }

    function getScrollMarginTop(element) {
        const value = parseFloat(
            window.getComputedStyle(element).scrollMarginTop
        );

        return Number.isFinite(value) ? Math.max(0, value) : 0;
    }

    function getStickyOffset(scrollTarget) {
        const candidates = getStickyOffsetCandidates();
        // Always reserve the settled floating-header band. Do not measure the
        // live header rect, or its slide-in animation will keep shifting offset.
        const ranges = [
            {
                top: 0,
                bottom: FLOATING_HEADER_HEIGHT
            }
        ];

        candidates.forEach(function (element) {
            if (
                element === scrollTarget ||
                shouldIgnoreOffsetElement(scrollTarget, element) ||
                !document.contains(element)
            ) {
                return;
            }

            const styles = window.getComputedStyle(element);

            if (styles.position !== "fixed" && styles.position !== "sticky") {
                return;
            }

            const rect = element.getBoundingClientRect();

            if (rect.height <= 0 || rect.width <= 0 || rect.bottom <= 0) {
                return;
            }

            ranges.push({
                top: Math.max(0, rect.top),
                bottom: Math.max(0, rect.bottom)
            });
        });

        ranges.sort(function (a, b) {
            return a.top - b.top;
        });

        const offset = ranges.reduce(function (coveredBottom, range) {
            if (range.top > coveredBottom + POSITION_TOLERANCE) {
                return coveredBottom;
            }

            return Math.max(coveredBottom, range.bottom);
        }, 0);

        log("Calculated sticky viewport offset.", {
            offset,
            floatingHeaderHeight: FLOATING_HEADER_HEIGHT,
            candidateCount: candidates.length
        });

        return offset;
    }

    function getStickyOffsetCandidates() {
        const seen = [];
        const candidates = [];

        STICKY_OFFSET_SELECTORS.forEach(function (selector) {
            let elements;

            try {
                elements = document.querySelectorAll(selector);
            } catch (caughtError) {
                warn("Invalid sticky offset selector ignored.", {
                    selector,
                    error: caughtError
                });
                return;
            }

            Array.prototype.forEach.call(elements, function (element) {
                if (seen.indexOf(element) !== -1) {
                    return;
                }

                seen.push(element);
                candidates.push(element);
            });
        });

        return candidates;
    }

    function getFloatingHeaderElement() {
        return document.getElementById(FLOATING_HEADER_ID);
    }

    function isFloatingHeaderRelated(node) {
        if (!node) {
            return false;
        }

        const element =
            node.nodeType === 1 ? node : node.parentElement || null;

        if (!element) {
            return false;
        }

        if (
            element.id === FLOATING_HEADER_ID ||
            element.id === FLOATING_HEADER_SCROLL_ID
        ) {
            return true;
        }

        const header = getFloatingHeaderElement();
        if (header && header.contains(element)) {
            return true;
        }

        const scrollHeader = document.getElementById(FLOATING_HEADER_SCROLL_ID);
        return Boolean(scrollHeader && scrollHeader.contains(element));
    }

    function areFloatingHeaderOnlyMutations(mutations) {
        if (!mutations || !mutations.length) {
            return false;
        }

        return Array.prototype.every.call(mutations, function (mutation) {
            if (!isFloatingHeaderRelated(mutation.target)) {
                return false;
            }

            const relatedNodes = [];

            Array.prototype.forEach.call(mutation.addedNodes || [], function (node) {
                relatedNodes.push(node);
            });
            Array.prototype.forEach.call(mutation.removedNodes || [], function (node) {
                relatedNodes.push(node);
            });

            if (!relatedNodes.length) {
                return true;
            }

            return relatedNodes.every(function (node) {
                return isFloatingHeaderRelated(node);
            });
        });
    }

    function areFloatingHeaderOnlyResizeEntries(entries) {
        if (!entries || !entries.length) {
            return false;
        }

        return Array.prototype.every.call(entries, function (entry) {
            return isFloatingHeaderRelated(entry.target);
        });
    }

    function isFloatingHeaderOnlyLayoutShift(entry) {
        if (!entry || !entry.sources || !entry.sources.length) {
            return false;
        }

        return entry.sources.every(function (source) {
            return isFloatingHeaderRelated(source.node);
        });
    }

    function shouldIgnoreOffsetElement(scrollTarget, element) {
        if (isFloatingHeaderRelated(element)) {
            return true;
        }

        return (
            scrollTarget.id === "filterBarStickyArea" &&
            scrollTarget.contains(element)
        );
    }

    function markScrollActivity() {
        lastScrollActivityAt = now();
    }

    function clearPendingCorrection(reason) {
        if (!pendingCorrection) {
            return;
        }

        log("Pending position correction cleared.", {
            reason,
            pendingDuration: now() - pendingCorrection.firstDetectedAt,
            maxPositionError: pendingCorrection.maxPositionError
        });

        pendingCorrection = null;
    }

    function resetStability(reason) {
        if (stableSince === null) {
            return;
        }

        stableSince = null;
        log("Stability timer reset.", {
            reason
        });
    }

    function addUserCancelListeners() {
        window.addEventListener("wheel", cancelForUserInteraction, {
            passive: true,
            once: true
        });
        window.addEventListener("touchstart", cancelForUserInteraction, {
            passive: true,
            once: true
        });
        window.addEventListener("pointerdown", cancelForUserInteraction, {
            passive: true,
            once: true
        });
        window.addEventListener("keydown", cancelForKeyboardInteraction);
    }

    function removeUserCancelListeners() {
        window.removeEventListener("wheel", cancelForUserInteraction);
        window.removeEventListener("touchstart", cancelForUserInteraction);
        window.removeEventListener("pointerdown", cancelForUserInteraction);
        window.removeEventListener("keydown", cancelForKeyboardInteraction);
    }

    function cancelForUserInteraction(event) {
        log("User interaction detected. Automatic scrolling cancelled.", {
            eventType: event.type
        });

        cleanup("user-interaction");
    }

    function cancelForKeyboardInteraction(event) {
        const scrollKeys = [
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " "
        ];

        if (scrollKeys.indexOf(event.key) === -1) {
            return;
        }

        log("Keyboard scroll interaction detected.", {
            key: event.key
        });

        cleanup("keyboard-interaction");
    }

    function disconnectWaitObserver() {
        if (!waitObserver) {
            return;
        }

        waitObserver.disconnect();
        waitObserver = null;
    }

    function cleanup(reason) {
        if (cancelled) {
            return;
        }

        cancelled = true;
        active = false;

        disconnectWaitObserver();

        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
        }

        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }

        if (layoutShiftObserver) {
            layoutShiftObserver.disconnect();
            layoutShiftObserver = null;
        }

        if (rafId !== null) {
            window.cancelAnimationFrame(rafId);
            rafId = null;
        }

        window.clearInterval(checkIntervalId);
        window.clearTimeout(timeoutId);
        window.clearTimeout(delayedCheckTimeoutId);
        window.clearTimeout(adjustDelayTimeoutId);

        window.removeEventListener("load", scheduleLoadCheck);
        window.removeEventListener("scroll", scheduleScrollCheck);
        window.removeEventListener("resize", scheduleResizeCheck);
        window.removeEventListener("orientationchange", scheduleResizeCheck);

        if (window.visualViewport) {
            window.visualViewport.removeEventListener("resize", scheduleResizeCheck);
            window.visualViewport.removeEventListener("scroll", scheduleResizeCheck);
        }

        removeUserCancelListeners();

        window.__dynamicScrollTargetActive = false;

        log("Dynamic scroll process ended.", {
            reason,
            elapsedTime: elapsed(),
            correctionCount
        });
    }

    function now() {
        return window.performance && window.performance.now
            ? window.performance.now()
            : Date.now();
    }

    function elapsed() {
        return Math.round(now() - startTime);
    }

    function log(message, data) {
        if (!DEBUG) {
            return;
        }

        if (typeof data !== "undefined") {
            console.log(LOG_PREFIX + " " + message, data);
        } else {
            console.log(LOG_PREFIX + " " + message);
        }
    }

    function warn(message, data) {
        if (!DEBUG) {
            return;
        }

        if (typeof data !== "undefined") {
            console.warn(LOG_PREFIX + " " + message, data);
        } else {
            console.warn(LOG_PREFIX + " " + message);
        }
    }
})();
