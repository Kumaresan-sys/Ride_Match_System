'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerTicketRoutes = require('../../../routes/ticket-routes');

function createRouter() {
  const routes = new Map();
  return {
    register(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    get(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
}

test('support sections route returns backend support sections', async () => {
  const router = createRouter();
  registerTicketRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    services: {
      ticketService: {
        getSupportSections: () => [{ id: 'fare_issues', title: 'Fare Issues' }],
      },
    },
  });

  const handler = router.get('GET', '/api/v1/support/sections');
  const response = await handler({});

  assert.deepEqual(response.data, [{ id: 'fare_issues', title: 'Fare Issues' }]);
});

test('past ride issues route returns active backend issue tree', async () => {
  const router = createRouter();
  registerTicketRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-1' } }),
    services: {
      ticketService: {
        getSupportSections: () => [],
        listPastRideIssueCatalog: async () => ({
          success: true,
          data: {
            groups: [
              {
                id: 'group-1',
                title: 'Driver behavior',
                backendCategory: 'driver_vehicle_issue',
                showDriverDetails: true,
                subIssues: [{ id: 'sub-1', title: 'Driver was rude' }],
              },
            ],
          },
        }),
      },
    },
  });

  const handler = router.get('GET', '/api/v1/support/past-ride-issues');
  const response = await handler({});

  assert.equal(response.data.success, true);
  assert.equal(response.data.data.groups[0].title, 'Driver behavior');
  assert.equal(response.data.data.groups[0].subIssues[0].title, 'Driver was rude');
});

test('ticket create route derives user identity from auth session', async () => {
  const router = createRouter();
  let receivedPayload = null;
  registerTicketRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-42' } }),
    services: {
      ticketService: {
        getSupportSections: () => [],
        createTicket: async (payload) => {
          receivedPayload = payload;
          return {
            success: true,
            data: {
              id: 'ticket-1',
              ticketCode: 'SUP-20260312-AAAAAA',
            },
          };
        },
      },
    },
  });

  const handler = router.get('POST', '/api/v1/tickets');
  const response = await handler({
    body: {
      category: 'general_support',
      subject: 'App issue',
      message: 'Need help',
      userId: 'spoofed-user',
    },
    headers: {},
    files: [],
    ip: '127.0.0.1',
  });

  assert.equal(response.status, 201);
  assert.equal(receivedPayload.userId, 'user-42');
  assert.equal(receivedPayload.category, 'general_support');
  assert.equal(receivedPayload.subject, 'App issue');
});

test('ticket list route passes cursor and search filters through service', async () => {
  const router = createRouter();
  let receivedFilters = null;
  registerTicketRoutes(router, {
    requireAuth: async () => ({ session: { userId: 'user-9' } }),
    services: {
      ticketService: {
        getSupportSections: () => [],
        listUserTickets: async (_userId, filters) => {
          receivedFilters = filters;
          return {
            success: true,
            data: {
              tickets: [],
              nextCursor: null,
            },
          };
        },
      },
    },
  });

  const handler = router.get('GET', '/api/v1/tickets');
  const response = await handler({
    params: new URLSearchParams('status=OPEN&search=sup-2026&limit=15&cursor=abc123'),
    headers: {},
  });

  assert.equal(response.data.success, true);
  assert.deepEqual(receivedFilters, {
    status: 'OPEN',
    search: 'sup-2026',
    limit: 15,
    cursor: 'abc123',
  });
});
