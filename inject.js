// Early injection script - intercepts fetch/XHR before page scripts run
(function () {
  'use strict';

  const scriptContent = `
    (function () {
      'use strict';

      window.__cursorTokenPricesActive = true;

      const AGGREGATION_PAGE_SIZE = 500;
      const API_PATTERNS = [
        /get-filtered-usage-events/,
        /get-usage-events/,
        /\\/api\\/dashboard\\/.*usage/,
        /\\/api\\/usage/,
      ];

      let aggregationRunId = 0;

      function isApiUrl(url) {
        if (!url) return false;
        const urlString = typeof url === 'string' ? url : url?.url || url?.toString?.() || '';
        return API_PATTERNS.some((p) => p.test(urlString));
      }

      function headersToObject(headersInit) {
        if (!headersInit) return {};
        if (headersInit instanceof Headers) return Object.fromEntries(headersInit.entries());
        if (Array.isArray(headersInit)) return Object.fromEntries(headersInit);
        return { ...headersInit };
      }

      function parseJson(value) {
        if (!value || typeof value !== 'string') return null;
        try {
          return JSON.parse(value);
        } catch (e) {
          return null;
        }
      }

      function toNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }

      function extractTotalEvents(data, fallbackCount) {
        const candidates = [
          data && data.totalUsageEventsCount,
          data && data.totalEvents,
          data && data.count,
          data && data.pagination && data.pagination.total,
          data && data.pageInfo && data.pageInfo.total,
        ];

        for (const value of candidates) {
          const parsed = toNumber(value);
          if (parsed != null) return parsed;
        }

        return fallbackCount;
      }

      function extractEvents(data) {
        const events = (data && (data.usageEventsDisplay || data.events)) || [];
        return {
          events,
          totalEvents: extractTotalEvents(data, events.length),
          totalCostCents: events.reduce((sum, e) => sum + (e.tokenUsage && e.tokenUsage.totalCents || 0), 0),
          lastUpdated: new Date(),
        };
      }

      function getEventKey(event, index) {
        const parts = [
          event && event.requestId || '',
          event && event.timestamp || '',
          event && event.model || '',
          event && event.tokenUsage && event.tokenUsage.totalCents != null ? event.tokenUsage.totalCents : '',
          event && event.tokenUsage && event.tokenUsage.inputTokens != null ? event.tokenUsage.inputTokens : '',
          event && event.tokenUsage && event.tokenUsage.outputTokens != null ? event.tokenUsage.outputTokens : '',
          event && event.tokenUsage && event.tokenUsage.cacheReadTokens != null ? event.tokenUsage.cacheReadTokens : '',
          event && event.tokenUsage && event.tokenUsage.cacheWriteTokens != null ? event.tokenUsage.cacheWriteTokens : '',
        ];

        if (parts.some(Boolean)) return parts.join('|');
        return 'fallback|' + index + '|' + JSON.stringify(event || {});
      }

      function addUniqueEvents(events, seenKeys) {
        let addedEvents = 0;
        let addedCostCents = 0;

        events.forEach(function (event, index) {
          const key = getEventKey(event, index);
          if (seenKeys.has(key)) return;
          seenKeys.add(key);
          addedEvents += 1;
          addedCostCents += event && event.tokenUsage && event.tokenUsage.totalCents || 0;
        });

        return { addedEvents, addedCostCents };
      }

      function dispatchData(data) {
        window.__cursorUsageData = data;
        window.dispatchEvent(new CustomEvent('cursor-usage-data', { detail: data }));
      }

      function dispatchTotalData(data) {
        window.__cursorUsageTotalData = data;
        window.dispatchEvent(new CustomEvent('cursor-usage-total-data', { detail: data }));
      }

      async function normalizeFetchRequest(args) {
        const input = args[0];
        const init = args[1] || {};
        const inputIsRequest = typeof Request !== 'undefined' && input instanceof Request;
        const headers = headersToObject(init.headers || (inputIsRequest ? input.headers : undefined));
        let body = init.body != null ? init.body : null;

        if (body == null && inputIsRequest && input.method && !['GET', 'HEAD'].includes(input.method.toUpperCase())) {
          try {
            body = await input.clone().text();
          } catch (e) {}
        }

        return {
          url: typeof input === 'string' ? input : input && input.url || '',
          method: (init.method || input && input.method || 'GET').toUpperCase(),
          headers,
          body: typeof body === 'string' ? body : null,
        };
      }

      function getAggregationConfig(requestDetails) {
        const body = parseJson(requestDetails.body);
        if (body && typeof body === 'object' && ('page' in body || 'pageSize' in body)) {
          return {
            location: 'body',
            startPage: toNumber(body.page) === 0 ? 0 : 1,
          };
        }

        const url = new URL(requestDetails.url, window.location.origin);
        const page = toNumber(url.searchParams.get('page'));
        if (page != null || url.searchParams.has('pageSize')) {
          return {
            location: 'query',
            startPage: page === 0 ? 0 : 1,
          };
        }

        return null;
      }

      function buildAggregationRequest(requestDetails, config, page) {
        const url = new URL(requestDetails.url, window.location.origin);
        const headers = { ...requestDetails.headers };
        let body = requestDetails.body;

        if (config.location === 'body') {
          const bodyObject = parseJson(requestDetails.body) || {};
          bodyObject.page = page;
          bodyObject.pageSize = AGGREGATION_PAGE_SIZE;
          body = JSON.stringify(bodyObject);

          if (!headers['content-type'] && !headers['Content-Type']) {
            headers['content-type'] = 'application/json';
          }
        } else {
          url.searchParams.set('page', String(page));
          url.searchParams.set('pageSize', String(AGGREGATION_PAGE_SIZE));
        }

        const options = {
          method: requestDetails.method,
          headers,
          credentials: 'same-origin',
        };

        if (!['GET', 'HEAD'].includes(requestDetails.method) && body != null) {
          options.body = body;
        }

        return { url: url.toString(), options };
      }

      async function aggregateTotal(originalFetch, requestDetails, baseData) {
        const totalEvents = baseData.totalEvents || baseData.events.length;

        if (!totalEvents) {
          dispatchTotalData({
            totalCostCents: 0,
            totalEvents: 0,
            aggregatedEventsCount: 0,
            status: 'ready',
            pageSize: AGGREGATION_PAGE_SIZE,
          });
          return;
        }

        if (baseData.events.length >= totalEvents) {
          dispatchTotalData({
            totalCostCents: baseData.totalCostCents,
            totalEvents: totalEvents,
            aggregatedEventsCount: baseData.events.length,
            status: 'ready',
            pageSize: AGGREGATION_PAGE_SIZE,
          });
          return;
        }

        const config = getAggregationConfig(requestDetails);
        if (!config) {
          dispatchTotalData({
            totalCostCents: baseData.totalCostCents,
            totalEvents: totalEvents,
            aggregatedEventsCount: baseData.events.length,
            status: 'partial',
            pageSize: AGGREGATION_PAGE_SIZE,
          });
          return;
        }

        const runId = ++aggregationRunId;
        dispatchTotalData({
          totalCostCents: null,
          totalEvents: totalEvents,
          aggregatedEventsCount: 0,
          status: 'loading',
          pageSize: AGGREGATION_PAGE_SIZE,
        });

        const totalPages = Math.max(1, Math.ceil(totalEvents / AGGREGATION_PAGE_SIZE));
        const seenKeys = new Set();
        let totalCostCents = 0;
        let aggregatedEventsCount = 0;

        for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
          if (runId !== aggregationRunId) return;

          const request = buildAggregationRequest(requestDetails, config, config.startPage + pageIndex);

          try {
            const response = await originalFetch(request.url, request.options);
            if (!response.ok) break;

            const pageData = extractEvents(await response.json());
            if (!pageData.events.length) break;

            const added = addUniqueEvents(pageData.events, seenKeys);
            aggregatedEventsCount += added.addedEvents;
            totalCostCents += added.addedCostCents;

            if (pageData.events.length < AGGREGATION_PAGE_SIZE) break;
          } catch (e) {
            break;
          }
        }

        if (runId !== aggregationRunId) return;

        dispatchTotalData({
          totalCostCents: totalCostCents,
          totalEvents: totalEvents,
          aggregatedEventsCount: aggregatedEventsCount,
          status: aggregatedEventsCount >= totalEvents ? 'ready' : 'partial',
          pageSize: AGGREGATION_PAGE_SIZE,
        });
      }

      const originalFetch = window.fetch;
      window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0];

        if (isApiUrl(url)) {
          try {
            const data = extractEvents(await response.clone().json());
            dispatchData(data);

            Promise.resolve().then(async function () {
              try {
                const requestDetails = await normalizeFetchRequest(args);
                await aggregateTotal(originalFetch, requestDetails, data);
              } catch (e) {}
            });
          } catch (e) {}
        }
        return response;
      };

      const originalXHROpen = XMLHttpRequest.prototype.open;
      const originalXHRSend = XMLHttpRequest.prototype.send;
      const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._url = url;
        this._method = (method || 'GET').toUpperCase();
        this._headers = {};
        return originalXHROpen.apply(this, [method, url, ...rest]);
      };

      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (!this._headers) this._headers = {};
        this._headers[name] = value;
        return originalXHRSetRequestHeader.apply(this, [name, value]);
      };

      XMLHttpRequest.prototype.send = function (...args) {
        const xhr = this;
        xhr._body = typeof args[0] === 'string' ? args[0] : null;

        if (isApiUrl(xhr._url)) {
          const onReady = function () {
            if (xhr.readyState === 4 && xhr.status === 200) {
              try {
                const data = extractEvents(JSON.parse(xhr.responseText));
                dispatchData(data);

                Promise.resolve().then(async function () {
                  try {
                    await aggregateTotal(
                      originalFetch,
                      {
                        url: xhr._url,
                        method: xhr._method || 'GET',
                        headers: { ...(xhr._headers || {}) },
                        body: xhr._body,
                      },
                      data
                    );
                  } catch (e) {}
                });
              } catch (e) {}
            }
          };

          const original = xhr.onreadystatechange;
          xhr.onreadystatechange = function () {
            onReady();
            if (original) original.apply(this, arguments);
          };
        }
        return originalXHRSend.apply(this, args);
      };
    })();
  `;

  const script = document.createElement('script');
  script.textContent = scriptContent;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
})();
