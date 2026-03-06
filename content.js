// Cursor Token Prices Extension - Displays API costs in the Cursor usage table
(function () {
  'use strict';

  const store = {
    events: [],
    viewKey: null,
  };
  const totalStore = {
    totalCostCents: null,
    totalEvents: 0,
    aggregatedEventsCount: 0,
    status: 'idle',
    pageSize: 500,
    filterSignature: null,
    requestId: null,
    requestKey: null,
    viewKey: null,
  };
  const filterCache = new Map();
  let assignedEvents = new Set();
  let processedRows = new Set();
  let observer = null;
  let retryInterval = null;
  let loadingFallbackTimeout = null;
  let forcedRefreshTimeout = null;
  let currentFilterSignature = null;
  let minAcceptedRequestId = 0;
  let pendingPresetSignature = null;
  let presetLockUntil = 0;
  const MONTH_INDEX = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  const formatCents = (cents) => {
    if (cents == null) return '-';
    if (cents === 0) return '$0.00';
    const dollars = cents / 100;
    return dollars < 0.01 ? `$${dollars.toFixed(3)}` : `$${dollars.toFixed(2)}`;
  };

  const isUsageRoute = () => {
    const url = new URL(window.location.href);
    return url.pathname === '/dashboard' && url.searchParams.get('tab') === 'usage';
  };

  const hasUsageData = (data) => {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.events) || Array.isArray(data.usageEventsDisplay)) return true;
    return data.totalEvents != null || data.totalUsageEventsCount != null;
  };

  const isSettledTotalStatus = (status) => status === 'ready' || status === 'partial';

  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  const debugLog = () => {};

  const publishDebugState = () => {};

  const getRangeForFilterSignature = (filterSignature) => {
    if (!filterSignature) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (filterSignature === 'preset:1d' || filterSignature === 'preset:7d' || filterSignature === 'preset:30d') {
      const days = Number(filterSignature.match(/\d+/)?.[0] || 0);
      if (!days) return null;

      const start = new Date(today);
      start.setDate(start.getDate() - (days - 1));
      const end = new Date(today);
      end.setHours(23, 59, 59, 999);
      return {
        startDateMs: start.getTime(),
        endDateMs: end.getTime(),
      };
    }

    if (!filterSignature.startsWith('range:')) return null;

    const label = filterSignature.slice('range:'.length).trim();
    const match = label.match(/^([A-Za-z]{3})\s+(\d{1,2})\s*-\s*([A-Za-z]{3})\s+(\d{1,2})$/);
    if (!match) return null;

    const [, startMonthLabel, startDayText, endMonthLabel, endDayText] = match;
    const startMonth = MONTH_INDEX[startMonthLabel.toLowerCase()];
    const endMonth = MONTH_INDEX[endMonthLabel.toLowerCase()];
    if (startMonth == null || endMonth == null) return null;

    let endYear = today.getFullYear();
    let startYear = endYear;
    if (startMonth > endMonth) {
      startYear -= 1;
    }

    const start = new Date(startYear, startMonth, Number(startDayText), 0, 0, 0, 0);
    const end = new Date(endYear, endMonth, Number(endDayText), 23, 59, 59, 999);
    return {
      startDateMs: start.getTime(),
      endDateMs: end.getTime(),
    };
  };

  const getCurrentFilterSignature = () => {
    if (!isUsageRoute()) return null;

    const controlsRoot = document.querySelector('.dashboard-segmented-control')?.parentElement || document;
    const activePreset = normalizeText(
      controlsRoot.querySelector('.dashboard-segmented-control-option-active')?.textContent || ''
    );
    const dateLabel = normalizeText(
      controlsRoot.querySelector('.dashboard-tabular-nums')?.textContent || ''
    );

    if (activePreset) return `preset:${activePreset.toLowerCase()}`;
    if (dateLabel) return `range:${dateLabel}`;
    return null;
  };

  const getPresetSignatureFromElement = (element) => {
    const button = element?.closest?.('.dashboard-segmented-control-option');
    if (!button) return null;

    const label = normalizeText(button.textContent || '');
    if (!label) return null;
    return `preset:${label.toLowerCase()}`;
  };

  const getLatestStartedRequestId = () => {
    const value = Number(window.__cursorUsageLatestStartedRequestId);
    return Number.isFinite(value) ? value : 0;
  };

  const getRequestPathFromKey = (requestKey) => {
    if (!requestKey || typeof requestKey !== 'string') return null;

    try {
      const parsed = JSON.parse(requestKey);
      return typeof parsed?.path === 'string' ? parsed.path : null;
    } catch (e) {
      return null;
    }
  };

  const isUsageEventsRequestPath = (requestPath) =>
    /get-filtered-usage-events|get-usage-events/.test(requestPath || '');

  const isRelevantUsagePayload = (data) => {
    if (!data || typeof data !== 'object') return false;

    const requestPath = getRequestPathFromKey(data.requestKey);
    if (isUsageEventsRequestPath(requestPath)) return true;

    if (!data.filterSignature) return false;
    if (!currentFilterSignature) return true;
    return data.filterSignature === currentFilterSignature || data.filterSignature === pendingPresetSignature;
  };

  const getEventIdentity = (event, index) => {
    const parts = [
      event?.requestId || '',
      event?.timestamp || '',
      event?.model || '',
      event?.tokenUsage?.totalCents ?? '',
      event?.tokenUsage?.inputTokens ?? '',
      event?.tokenUsage?.outputTokens ?? '',
      event?.tokenUsage?.cacheReadTokens ?? '',
      event?.tokenUsage?.cacheWriteTokens ?? '',
    ];
    return parts.some(Boolean) ? parts.join('|') : `fallback|${index}|${JSON.stringify(event || {})}`;
  };

  const getViewKey = (data, events, totalEvents) => {
    if (data?.viewKey) return data.viewKey;

    const firstEvent = events.length ? getEventIdentity(events[0], 0) : '';
    const lastIndex = events.length - 1;
    const lastEvent = lastIndex >= 0 ? getEventIdentity(events[lastIndex], lastIndex) : '';

    return JSON.stringify({
      requestKey: data?.requestKey || null,
      totalEvents,
      pageSize: events.length,
      firstEvent,
      lastEvent,
    });
  };

  const getToolbarContainer = () => {
    const exportButton = Array.from(document.querySelectorAll('button')).find((button) =>
      /export csv/i.test(button.textContent || '')
    );

    return exportButton?.parentElement?.parentElement || exportButton?.parentElement || null;
  };

  const cacheCurrentFilterState = () => {
    const filterSignature = totalStore.filterSignature || currentFilterSignature;
    if (!filterSignature) return;

    const existing = filterCache.get(filterSignature) || {};
    const next = {
      events: store.events.length ? store.events.slice() : existing.events || [],
      total: existing.total || null,
    };

    if (isSettledTotalStatus(totalStore.status)) {
      next.total = {
        totalCostCents: totalStore.totalCostCents,
        totalEvents: totalStore.totalEvents,
        aggregatedEventsCount: totalStore.aggregatedEventsCount,
        status: totalStore.status,
        pageSize: totalStore.pageSize,
      };
    }

    if (next.events.length || next.total) {
      filterCache.set(filterSignature, next);
      debugLog('cache:write', {
        filterSignature,
        eventCount: next.events.length,
        hasTotal: Boolean(next.total),
        totalStatus: next.total?.status || null,
      });
    }
  };

  const applyCachedFilterState = (filterSignature) => {
    const cached = filterCache.get(filterSignature);
    if (!cached) {
      debugLog('cache:miss', { filterSignature });
      return false;
    }

    resetState();
    store.events = cached.events ? cached.events.slice() : [];
    store.viewKey = null;
    totalStore.filterSignature = filterSignature;
    totalStore.requestId = null;
    totalStore.requestKey = null;
    totalStore.viewKey = null;

    if (cached.total) {
      totalStore.totalCostCents = cached.total.totalCostCents ?? null;
      totalStore.totalEvents = cached.total.totalEvents ?? 0;
      totalStore.aggregatedEventsCount = cached.total.aggregatedEventsCount ?? 0;
      totalStore.status = cached.total.status || 'ready';
      totalStore.pageSize = cached.total.pageSize || totalStore.pageSize;
      clearLoadingFallback();
    } else {
      totalStore.totalCostCents = null;
      totalStore.totalEvents = 0;
      totalStore.aggregatedEventsCount = 0;
      totalStore.status = 'loading';
      scheduleLoadingFallback();
    }

    renderTotalCost();
    if (store.events.length) {
      watchForTableChanges();
    }

    debugLog('cache:apply', {
      filterSignature,
      eventCount: store.events.length,
      status: totalStore.status,
      totalCostCents: totalStore.totalCostCents,
    });
    publishDebugState('cache:apply');

    return true;
  };

  const renderTotalCost = () => {
    if (!isUsageRoute()) {
      document.querySelector('.cursor-total-cost')?.remove();
      return;
    }

    const toolbarContainer = getToolbarContainer();
    if (!toolbarContainer) return;

    let totalEl = toolbarContainer.querySelector('.cursor-total-cost');
    const shouldShow =
      totalStore.status === 'loading' ||
      totalStore.status === 'partial' ||
      (totalStore.status === 'ready' && totalStore.totalCostCents != null);

    if (!shouldShow) {
      totalEl?.remove();
      return;
    }

    if (!totalEl) {
      totalEl = document.createElement('div');
      totalEl.className = 'cursor-total-cost';
      toolbarContainer.insertBefore(totalEl, toolbarContainer.lastElementChild || null);
    }

    const valueText = totalStore.status === 'loading' ? 'Calculating...' : formatCents(totalStore.totalCostCents);
    const metaText =
      totalStore.status === 'loading'
        ? `Fetching totals in ${totalStore.pageSize}-row pages`
        : totalStore.status === 'partial'
          ? `Summed ${totalStore.aggregatedEventsCount.toLocaleString()} of ${totalStore.totalEvents.toLocaleString()} requests`
          : `Summed ${totalStore.aggregatedEventsCount.toLocaleString()} requests`;

    totalEl.innerHTML = `
      <span class="cursor-total-cost-label">Total cost</span>
      <span class="cursor-total-cost-value">${valueText}</span>
      <span class="cursor-total-cost-meta">${metaText}</span>
    `;
    totalEl.title = metaText;
  };

  const clearLoadingFallback = () => {
    if (loadingFallbackTimeout) {
      clearTimeout(loadingFallbackTimeout);
      loadingFallbackTimeout = null;
    }
  };

  const scheduleLoadingFallback = () => {
    clearLoadingFallback();

    if (totalStore.status !== 'loading' || !store.events.length) return;

    const loadingViewKey = totalStore.viewKey;
    debugLog('fallback:arm', {
      filterSignature: totalStore.filterSignature,
      requestId: totalStore.requestId,
      loadingViewKey,
      eventCount: store.events.length,
      totalEvents: totalStore.totalEvents,
    });
    loadingFallbackTimeout = setTimeout(() => {
      if (totalStore.status !== 'loading' || totalStore.viewKey !== loadingViewKey) return;

      totalStore.totalCostCents = store.events.reduce(
        (sum, event) => sum + (event?.tokenUsage?.totalCents ?? 0),
        0
      );
      totalStore.totalEvents = totalStore.totalEvents || store.events.length;
      totalStore.aggregatedEventsCount = store.events.length;
      totalStore.status = 'partial';
      cacheCurrentFilterState();
      debugLog('fallback:fire', {
        filterSignature: totalStore.filterSignature,
        requestId: totalStore.requestId,
        totalCostCents: totalStore.totalCostCents,
        aggregatedEventsCount: totalStore.aggregatedEventsCount,
        totalEvents: totalStore.totalEvents,
      });
      publishDebugState('fallback:fire');
      renderTotalCost();
    }, 4000);
  };

  const getRowId = (row, index) => {
    const ts = row.querySelector('[title*="Feb"], [title*="Jan"], [title*="2026"]');
    if (ts) return ts.getAttribute('title') || ts.textContent;
    const text = row.textContent?.substring(0, 100);
    return text ? `${index}-${text}` : null;
  };

  const findMatchingEvent = (rowText, rowIndex) => {
    if (!store.events.length) return null;

    // Match by position (both sorted newest first)
    if (rowIndex > 0 && rowIndex <= store.events.length) {
      const ev = store.events[rowIndex - 1];
      if (ev && !assignedEvents.has(ev.timestamp)) {
        assignedEvents.add(ev.timestamp);
        return ev;
      }
    }

    // Fallback: match by model
    const match = rowText.match(/(kimi-k2\.5|gpt-5\.3-codex[^\s]*|claude-4\.6-opus[^\s]*|composer-1[^\s]*|auto)/i);
    const rowModel = match?.[1].toLowerCase();

    if (rowModel) {
      for (const ev of store.events) {
        if ((ev.model || '').toLowerCase().includes(rowModel) && !assignedEvents.has(ev.timestamp)) {
          assignedEvents.add(ev.timestamp);
          return ev;
        }
      }
    }

    // Last resort: first unassigned
    for (const ev of store.events) {
      if (!assignedEvents.has(ev.timestamp)) {
        assignedEvents.add(ev.timestamp);
        return ev;
      }
    }
    return null;
  };

  const injectIntoTable = () => {
    renderTotalCost();
    if (!store.events.length) return;

    document
      .querySelectorAll('.dashboard-table-rows, [role="rowgroup"], .dashboard-table-container')
      .forEach((container) => {
        container.querySelectorAll('[role="row"], .dashboard-table-row').forEach((row, idx) => {
          if (row.querySelector('[role="columnheader"], .dashboard-table-header')) return;

          const rowId = getRowId(row, idx);
          if (!rowId || processedRows.has(rowId)) return;

          const ev = findMatchingEvent(row.textContent || '', idx);
          if (!ev) return;

          const tokenUsage = ev.tokenUsage;
          if (!tokenUsage) return;
          const cost = tokenUsage.totalCents ?? 0;

          const cells = row.querySelectorAll('[role="cell"], .dashboard-table-cell');
          const costCell = cells[cells.length - 1];
          if (!costCell || costCell.querySelector('.cursor-cost-inline')) return;

          const badge = document.createElement('span');
          badge.className = 'cursor-cost-inline';
          badge.textContent = formatCents(cost);

          const parts = [];
          if (tokenUsage.inputTokens != null) parts.push(`Input: ${tokenUsage.inputTokens.toLocaleString()}`);
          if (tokenUsage.outputTokens != null) parts.push(`Output: ${tokenUsage.outputTokens.toLocaleString()}`);
          if (tokenUsage.cacheReadTokens != null) parts.push(`Cache read: ${tokenUsage.cacheReadTokens.toLocaleString()}`);
          if (tokenUsage.cacheWriteTokens != null) parts.push(`Cache write: ${tokenUsage.cacheWriteTokens.toLocaleString()}`);
          if (parts.length) badge.title = parts.join('\n');

          costCell.appendChild(badge);
          processedRows.add(rowId);
        });
      });
  };

  const resetState = () => {
    assignedEvents = new Set();
    processedRows = new Set();
    document.querySelectorAll('.cursor-cost-inline').forEach((el) => el.remove());
  };

  const watchForTableChanges = () => {
    injectIntoTable();

    if (!observer) {
      observer = new MutationObserver((mutations) => {
        handleFilterSignatureChange();
        const shouldInject = mutations.some((m) =>
          Array.from(m.addedNodes).some(
            (n) =>
              n.nodeType === Node.ELEMENT_NODE &&
              (n.matches?.('[role="row"], .dashboard-table-row') ||
                n.querySelector?.('[role="row"], .dashboard-table-row'))
          )
        );
        if (shouldInject) injectIntoTable();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    if (retryInterval) clearInterval(retryInterval);
    let attempts = 0;
    retryInterval = setInterval(() => {
      injectIntoTable();
      if (++attempts >= 10) clearInterval(retryInterval);
    }, 500);
  };

  const processApiResponse = (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isRelevantUsagePayload(data)) {
      debugLog('api:ignore-irrelevant', {
        requestId: data.requestId ?? null,
        filterSignature: data.filterSignature || null,
        requestPath: getRequestPathFromKey(data.requestKey),
      });
      return;
    }

    const events = data.events || data.usageEventsDisplay || [];
    const totalEvents = data.totalEvents ?? events.length;
    const requestId = data.requestId ?? null;
    const requestKey = data.requestKey || null;
    const viewKey = getViewKey(data, events, totalEvents);
    if (requestId != null && requestId < minAcceptedRequestId) {
      debugLog('api:reject-old-request', {
        requestId,
        minAcceptedRequestId,
        filterSignature: data.filterSignature || null,
        totalEvents,
        eventCount: events.length,
      });
      return;
    }
    const hasSettledTotalForSameRequest =
      (requestId != null && totalStore.requestId === requestId && isSettledTotalStatus(totalStore.status)) ||
      (requestId == null &&
        viewKey &&
        totalStore.viewKey === viewKey &&
        isSettledTotalStatus(totalStore.status));
    const shouldRender = isUsageRoute();

    if (!currentFilterSignature && data.filterSignature) {
      currentFilterSignature = data.filterSignature;
    }
    if (pendingPresetSignature && data.filterSignature === pendingPresetSignature) {
      clearPresetLock('api-response');
    }
    debugLog('api:accept', {
      requestId,
      requestKey,
      filterSignature: currentFilterSignature,
      totalEvents,
      eventCount: events.length,
      hasSettledTotalForSameRequest,
    });
    totalStore.filterSignature = currentFilterSignature;
    totalStore.requestId = requestId;
    store.viewKey = viewKey;
    totalStore.viewKey = viewKey;
    totalStore.requestKey = requestKey;

    if (totalEvents === 0) {
      totalStore.totalCostCents = 0;
      totalStore.totalEvents = 0;
      totalStore.aggregatedEventsCount = 0;
      totalStore.status = 'ready';
    } else if (!hasSettledTotalForSameRequest) {
      // Clear stale totals only when the active request actually changed.
      totalStore.totalCostCents = null;
      totalStore.totalEvents = totalEvents;
      totalStore.aggregatedEventsCount = 0;
      totalStore.status = 'loading';
    } else {
      totalStore.totalEvents = totalEvents;
    }

    if (totalStore.status === 'loading') {
      scheduleLoadingFallback();
    } else {
      clearLoadingFallback();
    }

    if (shouldRender) {
      renderTotalCost();
    }

    if (!events.length) {
      resetState();
      store.events = [];
      cacheCurrentFilterState();
      publishDebugState('api:empty');
      return;
    }

    resetState();
    store.events = events;
    cacheCurrentFilterState();
    publishDebugState('api:accept');

    if (totalStore.status === 'loading') {
      scheduleLoadingFallback();
    }

    if (!shouldRender) return;

    watchForTableChanges();
  };

  const processTotalResponse = (data) => {
    if (!data || typeof data !== 'object') return;
    if (!isRelevantUsagePayload(data)) {
      debugLog('total:ignore-irrelevant', {
        requestId: data.requestId ?? null,
        filterSignature: data.filterSignature || null,
        requestPath: getRequestPathFromKey(data.requestKey),
        status: data.status || null,
      });
      return;
    }
    if (data.requestId != null && data.requestId < minAcceptedRequestId) {
      debugLog('total:reject-old-request', {
        requestId: data.requestId,
        minAcceptedRequestId,
        status: data.status || null,
        filterSignature: data.filterSignature || null,
      });
      return;
    }
    if (totalStore.requestId != null && data.requestId != null && totalStore.requestId !== data.requestId) {
      debugLog('total:reject-request-mismatch', {
        incomingRequestId: data.requestId,
        activeRequestId: totalStore.requestId,
        status: data.status || null,
      });
      return;
    }
    if (totalStore.viewKey && data.viewKey && totalStore.viewKey !== data.viewKey) {
      debugLog('total:reject-view-mismatch', {
        incomingRequestId: data.requestId ?? null,
        incomingViewKey: data.viewKey,
        activeViewKey: totalStore.viewKey,
      });
      return;
    }
    if (totalStore.requestKey && data.requestKey && totalStore.requestKey !== data.requestKey) {
      debugLog('total:reject-request-key-mismatch', {
        incomingRequestId: data.requestId ?? null,
        activeRequestId: totalStore.requestId,
      });
      return;
    }

    if (!currentFilterSignature && data.filterSignature) {
      currentFilterSignature = data.filterSignature;
    }
    if (pendingPresetSignature && data.filterSignature === pendingPresetSignature) {
      clearPresetLock('total-response');
    }
    debugLog('total:accept', {
      requestId: data.requestId ?? null,
      filterSignature: currentFilterSignature,
      status: data.status || null,
      totalCostCents: data.totalCostCents != null ? data.totalCostCents : null,
      aggregatedEventsCount: data.aggregatedEventsCount ?? 0,
      totalEvents: data.totalEvents ?? 0,
    });
    totalStore.filterSignature = currentFilterSignature;
    totalStore.requestId = data.requestId ?? totalStore.requestId ?? null;
    totalStore.viewKey = data.viewKey || totalStore.viewKey || null;
    totalStore.requestKey = data.requestKey || totalStore.requestKey || null;
    totalStore.totalCostCents = data.totalCostCents ?? null;
    totalStore.totalEvents = data.totalEvents ?? 0;
    totalStore.aggregatedEventsCount = data.aggregatedEventsCount ?? 0;
    totalStore.status = data.status || 'idle';
    totalStore.pageSize = data.pageSize || 500;
    if (totalStore.status === 'loading') {
      scheduleLoadingFallback();
    } else if (isSettledTotalStatus(totalStore.status) || totalStore.status === 'idle') {
      clearLoadingFallback();
    }
    cacheCurrentFilterState();
    publishDebugState('total:accept');

    if (!isUsageRoute()) return;

    renderTotalCost();
  };

  const syncUsageStateFromWindow = () => {
    if (!isUsageRoute()) return;

    if (hasUsageData(window.__cursorUsageData)) {
      processApiResponse(window.__cursorUsageData);
    }

    if (window.__cursorUsageTotalData && typeof window.__cursorUsageTotalData === 'object') {
      processTotalResponse(window.__cursorUsageTotalData);
    }

    if (!store.events.length) {
      renderTotalCost();
    }
  };

  const scheduleUsageStateSync = (runImmediately = true) => {
    if (runImmediately) {
      syncUsageStateFromWindow();
    }
    [100, 250, 1000, 2500].forEach((delay) => {
      setTimeout(() => {
        syncUsageStateFromWindow();
      }, delay);
    });
  };

  const clearPresetLock = (reason) => {
    if (!pendingPresetSignature && presetLockUntil === 0) return;
    debugLog('filter:clear-preset-lock', {
      reason,
      pendingPresetSignature,
    });
    pendingPresetSignature = null;
    presetLockUntil = 0;
  };

  const scheduleForcedRefresh = (filterSignature, delay = 75) => {
    if (forcedRefreshTimeout) {
      clearTimeout(forcedRefreshTimeout);
      forcedRefreshTimeout = null;
    }

    if (!filterSignature) return;

    forcedRefreshTimeout = setTimeout(() => {
      forcedRefreshTimeout = null;

      if (filterSignature !== currentFilterSignature) {
        debugLog('force:skip-stale-filter', {
          scheduledFor: filterSignature,
          currentFilterSignature,
        });
        return;
      }

      const range = getRangeForFilterSignature(filterSignature);
      if (!range) {
        debugLog('force:skip-no-range', { filterSignature });
        return;
      }

      if (typeof window.__cursorTokenPricesForceRefresh !== 'function') {
        debugLog('force:skip-no-hook', { filterSignature });
        return;
      }

      debugLog('force:request', {
        filterSignature,
        startDateMs: range.startDateMs,
        endDateMs: range.endDateMs,
      });

      Promise.resolve(
        window.__cursorTokenPricesForceRefresh({
          filterSignature,
          startDateMs: range.startDateMs,
          endDateMs: range.endDateMs,
        })
      ).then((ok) => {
        debugLog('force:result', { filterSignature, ok: Boolean(ok) });
      });
    }, delay);
  };

  const handleFilterSignatureChange = () => {
    if (!isUsageRoute()) return;

    const nextFilterSignature = getCurrentFilterSignature();
    if (!nextFilterSignature) return;

    if (pendingPresetSignature) {
      if (nextFilterSignature === pendingPresetSignature) {
        clearPresetLock('dom-matched-preset');
      } else if (Date.now() < presetLockUntil) {
        debugLog('filter:ignore-dom-during-preset-lock', {
          domFilterSignature: nextFilterSignature,
          pendingPresetSignature,
          currentFilterSignature,
        });
        return;
      } else {
        clearPresetLock('preset-lock-timeout');
      }
    }

    if (currentFilterSignature == null) {
      currentFilterSignature = nextFilterSignature;
      totalStore.filterSignature = nextFilterSignature;
      debugLog('filter:init', { nextFilterSignature });
      return;
    }

    if (nextFilterSignature === currentFilterSignature) return;

    debugLog('filter:change', {
      from: currentFilterSignature,
      to: nextFilterSignature,
      latestStartedRequestId: getLatestStartedRequestId(),
    });
    currentFilterSignature = nextFilterSignature;
    totalStore.filterSignature = nextFilterSignature;
    minAcceptedRequestId = getLatestStartedRequestId() + 1;
    totalStore.requestId = null;
    totalStore.requestKey = null;
    totalStore.viewKey = null;
    store.viewKey = null;
    clearLoadingFallback();

    if (!applyCachedFilterState(nextFilterSignature)) {
      resetState();
      store.events = [];
      totalStore.totalCostCents = null;
      totalStore.totalEvents = 0;
      totalStore.aggregatedEventsCount = 0;
      totalStore.status = 'loading';
      renderTotalCost();
    }

    publishDebugState('filter:change');
    scheduleUsageStateSync(false);
    scheduleForcedRefresh(nextFilterSignature);
  };

  const setActiveFilterSignature = (nextFilterSignature) => {
    if (!isUsageRoute() || !nextFilterSignature || nextFilterSignature === currentFilterSignature) return;

    debugLog('filter:preset-click', {
      from: currentFilterSignature,
      to: nextFilterSignature,
      latestStartedRequestId: getLatestStartedRequestId(),
    });
    currentFilterSignature = nextFilterSignature;
    pendingPresetSignature = nextFilterSignature;
    presetLockUntil = Date.now() + 1500;
    totalStore.filterSignature = nextFilterSignature;
    minAcceptedRequestId = getLatestStartedRequestId() + 1;
    totalStore.requestId = null;
    totalStore.requestKey = null;
    totalStore.viewKey = null;
    store.viewKey = null;
    clearLoadingFallback();

    if (!applyCachedFilterState(nextFilterSignature)) {
      resetState();
      store.events = [];
      totalStore.totalCostCents = null;
      totalStore.totalEvents = 0;
      totalStore.aggregatedEventsCount = 0;
      totalStore.status = 'loading';
      renderTotalCost();
    }
    publishDebugState('filter:preset-click');
    scheduleForcedRefresh(nextFilterSignature);
  };

  let lastUrl = window.location.href;
  const handleRouteChange = () => {
    const nextUrl = window.location.href;
    if (nextUrl === lastUrl) return;
    lastUrl = nextUrl;

    if (!isUsageRoute()) {
      document.querySelector('.cursor-total-cost')?.remove();
      return;
    }

    currentFilterSignature = getCurrentFilterSignature();
    totalStore.filterSignature = currentFilterSignature;
    minAcceptedRequestId = 0;
    clearPresetLock('route-change');
    debugLog('route:usage', { currentFilterSignature });
    if (!applyCachedFilterState(currentFilterSignature)) {
      resetState();
      store.events = [];
      store.viewKey = null;
      totalStore.totalCostCents = null;
      totalStore.totalEvents = 0;
      totalStore.aggregatedEventsCount = 0;
      totalStore.status = 'loading';
      totalStore.requestId = null;
      totalStore.requestKey = null;
      totalStore.viewKey = null;
      renderTotalCost();
    }
    scheduleUsageStateSync();
    scheduleForcedRefresh(currentFilterSignature, 150);
  };

  const patchHistoryMethod = (methodName) => {
    const original = window.history[methodName];
    window.history[methodName] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(handleRouteChange);
      return result;
    };
  };

  // Initialize
  window.addEventListener('cursor-usage-data', (e) => processApiResponse(e.detail));
  window.addEventListener('cursor-usage-total-data', (e) => processTotalResponse(e.detail));
  window.addEventListener('popstate', handleRouteChange);
  window.addEventListener('hashchange', handleRouteChange);
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const presetSignature = getPresetSignatureFromElement(target);
      if (presetSignature) {
        setActiveFilterSignature(presetSignature);
        scheduleUsageStateSync(false);
        return;
      }

      if (!target.closest('.dashboard-segmented-control, .dashboard-outline-button')) return;

      [0, 50, 150, 400].forEach((delay) => {
        setTimeout(() => {
          handleFilterSignatureChange();
        }, delay);
      });
    },
    true
  );
  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');

  if (window.__cursorUsageTotalData) {
    processTotalResponse(window.__cursorUsageTotalData);
  }

  currentFilterSignature = getCurrentFilterSignature();
  totalStore.filterSignature = currentFilterSignature;
  minAcceptedRequestId = 0;
  clearPresetLock('initialize');
  if (hasUsageData(window.__cursorUsageData)) {
    processApiResponse(window.__cursorUsageData);
    return;
  }

  const interval = setInterval(() => {
    if (hasUsageData(window.__cursorUsageData)) {
      processApiResponse(window.__cursorUsageData);
      clearInterval(interval);
    }
  }, 500);

  setTimeout(() => clearInterval(interval), 30000);
  scheduleUsageStateSync();
})();
