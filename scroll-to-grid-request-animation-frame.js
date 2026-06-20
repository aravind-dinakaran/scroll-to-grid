(function () {
    const LOG_PREFIX = "[Monetate Dynamic Scroll]";
  
    const params = new URLSearchParams(window.location.search);
  
    const targetId = params.get("scrollToGridId");
  
    /*
     * Logs are enabled only when the URL contains:
     * scrollDebug=true
     */
    const DEBUG = params.get("scrollDebug") === "true";
  
    const MAX_WAIT_TIME = 10000;
    const REQUIRED_STABLE_TIME = 500;
    const POSITION_TOLERANCE = 2;
  
    const ALLOWED_TARGET_IDS = [
      "filterBarStickyArea",
      "wrapperProductGrid",
      "productGrid"
    ];
  
    function log(message, data) {
      if (!DEBUG) {
        return;
      }
  
      if (typeof data !== "undefined") {
        console.log(`${LOG_PREFIX} ${message}`, data);
      } else {
        console.log(`${LOG_PREFIX} ${message}`);
      }
    }
  
    function warn(message, data) {
      if (!DEBUG) {
        return;
      }
  
      if (typeof data !== "undefined") {
        console.warn(`${LOG_PREFIX} ${message}`, data);
      } else {
        console.warn(`${LOG_PREFIX} ${message}`);
      }
    }
  
    function error(message, data) {
      /*
       * This version also requires scrollDebug=true for errors.
       * Nothing is logged when debug mode is disabled.
       */
      if (!DEBUG) {
        return;
      }
  
      if (typeof data !== "undefined") {
        console.error(`${LOG_PREFIX} ${message}`, data);
      } else {
        console.error(`${LOG_PREFIX} ${message}`);
      }
    }
  
    log("Script initialized.", {
      url: window.location.href,
      targetId,
      debugEnabled: DEBUG
    });
  
    if (!targetId) {
      log(
        'No "scrollToGridId" query parameter found. Scroll behavior will not run.'
      );
      return;
    }
  
    if (!ALLOWED_TARGET_IDS.includes(targetId)) {
      warn("Target ID is not in the allowed target list.", {
        targetId,
        allowedTargetIds: ALLOWED_TARGET_IDS
      });
      return;
    }
  
    if (window.__dynamicScrollTargetActive) {
      warn(
        "A dynamic scroll process is already active. Duplicate execution stopped."
      );
      return;
    }
  
    window.__dynamicScrollTargetActive = true;
  
    const startTime = Date.now();
  
    let cancelled = false;
    let resizeObserver = null;
    let correctionCount = 0;
  
    log("Dynamic scroll process started.", {
      targetId,
      maxWaitTime: MAX_WAIT_TIME,
      requiredStableTime: REQUIRED_STABLE_TIME,
      positionTolerance: POSITION_TOLERANCE
    });
  
    function getHeaderOffset() {
      /*
       * Replace these example selectors with the actual selectors
       * for fixed or sticky headers on the page.
       */
      const headerSelectors = [
        "#filterBarStickyArea .quickFilterBar--KHVf2"
      ];
  
      const stickyElements = headerSelectors
        .map(function (selector) {
          return document.querySelector(selector);
        })
        .filter(Boolean);
  
      const headerOffset = stickyElements.reduce(function (total, element) {
        const styles = window.getComputedStyle(element);
  
        const isFixedOrSticky =
          styles.position === "fixed" ||
          styles.position === "sticky";
  
        if (!isFixedOrSticky) {
          return total;
        }
  
        const rect = element.getBoundingClientRect();
  
        const isVisibleAtTop =
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top <= 0;
  
        if (!isVisibleAtTop) {
          return total;
        }
  
        return total + rect.height;
      }, 0);
  
      log("Calculated sticky header offset.", {
        headerOffset,
        matchedHeaderCount: stickyElements.length
      });
  
      return headerOffset;
    }
  
    function scrollToTarget(target, reason) {
      if (!target) {
        warn("scrollToTarget was called without a valid target.");
        return;
      }
  
      const headerOffset = getHeaderOffset();
      const rect = target.getBoundingClientRect();
  
      const targetTop =
        window.scrollY +
        rect.top -
        headerOffset;
  
      correctionCount += 1;
  
      log("Scrolling to target.", {
        reason,
        targetId,
        correctionCount,
        currentScrollY: window.scrollY,
        targetViewportTop: rect.top,
        headerOffset,
        calculatedScrollTop: Math.max(0, targetTop)
      });
  
      window.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "auto"
      });
    }
  
    function cleanup(reason) {
      if (cancelled) {
        return;
      }
  
      cancelled = true;
  
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
  
      window.removeEventListener("wheel", cancelForUserInteraction);
      window.removeEventListener("touchstart", cancelForUserInteraction);
      window.removeEventListener("pointerdown", cancelForUserInteraction);
      window.removeEventListener("keydown", cancelForKeyboardInteraction);
  
      window.__dynamicScrollTargetActive = false;
  
      log("Dynamic scroll process ended.", {
        reason,
        elapsedTime: Date.now() - startTime,
        correctionCount
      });
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
  
      if (!scrollKeys.includes(event.key)) {
        return;
      }
  
      log("Keyboard scroll interaction detected.", {
        key: event.key
      });
  
      cleanup("keyboard-interaction");
    }
  
    function waitForTarget() {
      if (cancelled) {
        return;
      }
  
      const target = document.getElementById(targetId);
  
      if (target) {
        log("Target element found.", {
          targetId,
          elapsedTime: Date.now() - startTime,
          target
        });
  
        stabilizeScroll(target);
        return;
      }
  
      const elapsedTime = Date.now() - startTime;
  
      if (elapsedTime >= MAX_WAIT_TIME) {
        warn("Timed out while waiting for the target element.", {
          targetId,
          elapsedTime
        });
  
        cleanup("target-not-found-timeout");
        return;
      }
  
      requestAnimationFrame(waitForTarget);
    }
  
    function stabilizeScroll(initialTarget) {
      let target = initialTarget;
      let lastTop = null;
      let stableSince = null;
      let resizeCount = 0;
  
      log("Scroll stabilization started.", {
        targetId
      });
  
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
  
      if ("ResizeObserver" in window) {
        resizeObserver = new ResizeObserver(function () {
          resizeCount += 1;
          stableSince = null;
  
          log("Page layout size changed. Stability timer reset.", {
            resizeCount
          });
        });
  
        resizeObserver.observe(document.body);
  
        log("ResizeObserver attached to document.body.");
      } else {
        warn(
          "ResizeObserver is not supported. Position checks will still continue."
        );
      }
  
      function checkPosition() {
        if (cancelled) {
          return;
        }
  
        if (!document.contains(target)) {
          warn(
            "Original target node is no longer in the DOM. Looking for a replacement.",
            {
              targetId
            }
          );
  
          target = document.getElementById(targetId);
  
          if (!target) {
            const elapsedTime = Date.now() - startTime;
  
            if (elapsedTime >= MAX_WAIT_TIME) {
              warn("Replacement target was not found before timeout.", {
                targetId,
                elapsedTime
              });
  
              cleanup("replacement-target-not-found");
              return;
            }
  
            requestAnimationFrame(checkPosition);
            return;
          }
  
          log("Replacement target element found.", {
            targetId,
            target
          });
  
          lastTop = null;
          stableSince = null;
        }
  
        try {
          const headerOffset = getHeaderOffset();
          const currentTop = target.getBoundingClientRect().top;
          const desiredTop = headerOffset;
          const positionError = Math.abs(currentTop - desiredTop);
  
          const positionChanged =
            lastTop === null ||
            Math.abs(currentTop - lastTop) > POSITION_TOLERANCE;
  
          if (
            positionChanged ||
            positionError > POSITION_TOLERANCE
          ) {
            log("Target position requires correction.", {
              currentTop,
              desiredTop,
              positionError,
              lastTop,
              positionChanged
            });
  
            scrollToTarget(target, "position-correction");
            stableSince = null;
          } else if (stableSince === null) {
            stableSince = performance.now();
  
            log("Target entered stable position.", {
              currentTop,
              desiredTop
            });
          }
  
          lastTop = target.getBoundingClientRect().top;
  
          const stableDuration =
            stableSince === null
              ? 0
              : performance.now() - stableSince;
  
          const stableLongEnough =
            stableSince !== null &&
            stableDuration >= REQUIRED_STABLE_TIME;
  
          const elapsedTime = Date.now() - startTime;
          const timedOut = elapsedTime >= MAX_WAIT_TIME;
  
          if (stableLongEnough) {
            log("Target remained stable for the required duration.", {
              stableDuration,
              requiredStableTime: REQUIRED_STABLE_TIME
            });
  
            scrollToTarget(target, "final-stability-correction");
            cleanup("target-stabilized");
            return;
          }
  
          if (timedOut) {
            warn("Maximum stabilization time reached.", {
              elapsedTime,
              currentTop,
              desiredTop,
              positionError
            });
  
            scrollToTarget(target, "final-timeout-correction");
            cleanup("stabilization-timeout");
            return;
          }
  
          requestAnimationFrame(checkPosition);
        } catch (caughtError) {
          error("Unexpected error during position checking.", caughtError);
          cleanup("unexpected-error");
        }
      }
  
      scrollToTarget(target, "initial-scroll");
      requestAnimationFrame(checkPosition);
    }
  
    try {
      waitForTarget();
    } catch (caughtError) {
      error(
        "Unexpected error while starting dynamic scroll.",
        caughtError
      );
  
      window.__dynamicScrollTargetActive = false;
    }
  })();