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
    requestKey: null,
    viewKey: null,
  };
  const viewCache = new Map();
  const tableSignatureIndex = new Map();
  let assignedEvents = new Set();
  let processedRows = new Set();
  let observer = null;
  let retryInterval = null;
  let loadingFallbackTimeout = null;

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

  const updateViewCache = () => {
    const viewKey = totalStore.viewKey || store.viewKey;
    if (!viewKey) return;

    const existing = viewCache.get(viewKey) || {};
    const next = {
      viewKey,
      requestKey: totalStore.requestKey || existing.requestKey || null,
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
      viewCache.set(viewKey, next);
    }
  };

  const getRenderableRows = () => {
    const seen = new Set();
    const rows = [];

    document.querySelectorAll('[role="row"], .dashboard-table-row').forEach((row) => {
      if (!row || seen.has(row)) return;
      seen.add(row);

      if (row.querySelector('[role="columnheader"], .dashboard-table-header')) return;
      if (!row.querySelector('[role="cell"], .dashboard-table-cell')) return;

      rows.push(row);
    });

    return rows;
  };

  const normalizeText = (value) => value.replace(/\s+/g, ' ').trim();

  const getRowSignature = (row) => {
    const clone = row.cloneNode(true);
    clone.querySelectorAll('.cursor-cost-inline').forEach((el) => el.remove());

    const titles = Array.from(row.querySelectorAll('[title]'))
      .slice(0, 4)
      .map((el) => normalizeText(el.getAttribute('title') || ''))
      .filter(Boolean);
    const text = normalizeText(clone.textContent || '');

    if (!text) return null;
    return titles.length ? `${titles.join('|')}::${text}` : text;
  };

  const getTableSignature = () => {
    const rows = getRenderableRows();
    if (rows.length < 2) return null;

    const rowSignatures = rows
      .slice(0, Math.min(rows.length, 8))
      .map((row) => getRowSignature(row))
      .filter(Boolean);

    if (rowSignatures.length < 2) return null;

    return JSON.stringify({
      rowCount: rows.length,
      rows: rowSignatures,
    });
  };

  const restoreCachedViewFromSignature = (tableSignature) => {
    if (!tableSignature) return false;

    const cachedViewKey = tableSignatureIndex.get(tableSignature);
    if (!cachedViewKey || cachedViewKey === totalStore.viewKey) return false;

    const cachedView = viewCache.get(cachedViewKey);
    if (!cachedView?.events?.length) return false;

    store.events = cachedView.events.slice();
    store.viewKey = cachedViewKey;
    totalStore.viewKey = cachedViewKey;
    totalStore.requestKey = cachedView.requestKey || null;

    if (cachedView.total) {
      totalStore.totalCostCents = cachedView.total.totalCostCents ?? null;
      totalStore.totalEvents = cachedView.total.totalEvents ?? cachedView.events.length;
      totalStore.aggregatedEventsCount = cachedView.total.aggregatedEventsCount ?? 0;
      totalStore.status = cachedView.total.status || 'ready';
      totalStore.pageSize = cachedView.total.pageSize || totalStore.pageSize;
    } else {
      totalStore.totalCostCents = null;
      totalStore.totalEvents = cachedView.events.length;
      totalStore.aggregatedEventsCount = 0;
      totalStore.status = 'loading';
    }

    resetState();
    return true;
  };

  const getToolbarContainer = () => {
    const exportButton = Array.from(document.querySelectorAll('button')).find((button) =>
      /export csv/i.test(button.textContent || '')
    );

    return exportButton?.parentElement?.parentElement || exportButton?.parentElement || null;
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
    loadingFallbackTimeout = setTimeout(() => {
      if (totalStore.status !== 'loading' || totalStore.viewKey !== loadingViewKey) return;

      totalStore.totalCostCents = store.events.reduce(
        (sum, event) => sum + (event?.tokenUsage?.totalCents ?? 0),
        0
      );
      totalStore.totalEvents = totalStore.totalEvents || store.events.length;
      totalStore.aggregatedEventsCount = store.events.length;
      totalStore.status = 'partial';
      updateViewCache();
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
    const tableSignature = getTableSignature();
    restoreCachedViewFromSignature(tableSignature);
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

    updateViewCache();
    if (tableSignature && (totalStore.viewKey || store.viewKey)) {
      tableSignatureIndex.set(tableSignature, totalStore.viewKey || store.viewKey);
    }
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

    const events = data.events || data.usageEventsDisplay || [];
    const totalEvents = data.totalEvents ?? events.length;
    const requestKey = data.requestKey || null;
    const viewKey = getViewKey(data, events, totalEvents);
    const cachedView = viewCache.get(viewKey);
    const hasSettledTotalForSameView =
      viewKey && totalStore.viewKey === viewKey && isSettledTotalStatus(totalStore.status);
    const shouldRender = isUsageRoute();

    store.viewKey = viewKey;
    totalStore.viewKey = viewKey;
    totalStore.requestKey = requestKey;

    if (totalEvents === 0) {
      totalStore.totalCostCents = 0;
      totalStore.totalEvents = 0;
      totalStore.aggregatedEventsCount = 0;
      totalStore.status = 'ready';
    } else if (cachedView?.total) {
      totalStore.totalCostCents = cachedView.total.totalCostCents ?? null;
      totalStore.totalEvents = totalEvents;
      totalStore.aggregatedEventsCount = cachedView.total.aggregatedEventsCount ?? 0;
      totalStore.status = cachedView.total.status || 'ready';
      totalStore.pageSize = cachedView.total.pageSize || totalStore.pageSize;
    } else if (!hasSettledTotalForSameView) {
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
      updateViewCache();
      return;
    }

    resetState();
    store.events = events;
    updateViewCache();

    if (totalStore.status === 'loading') {
      scheduleLoadingFallback();
    }

    if (!shouldRender) return;

    watchForTableChanges();
  };

  const processTotalResponse = (data) => {
    if (!data || typeof data !== 'object') return;
    if (totalStore.viewKey && data.viewKey && totalStore.viewKey !== data.viewKey) return;
    if (totalStore.requestKey && data.requestKey && totalStore.requestKey !== data.requestKey) return;

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
    updateViewCache();

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

  const scheduleUsageStateSync = () => {
    syncUsageStateFromWindow();
    [250, 1000, 2500].forEach((delay) => {
      setTimeout(() => {
        syncUsageStateFromWindow();
      }, delay);
    });
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

    scheduleUsageStateSync();
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
  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');

  if (window.__cursorUsageTotalData) {
    processTotalResponse(window.__cursorUsageTotalData);
  }

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
