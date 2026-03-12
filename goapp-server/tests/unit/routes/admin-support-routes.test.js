'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registerAdminSupportRoutes = require('../../../routes/admin-support-routes');

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

test('admin support status route forwards status changes through ticket service', async () => {
  const router = createRouter();
  let captured = null;
  registerAdminSupportRoutes(router, {
    requireAdmin: () => null,
    services: {
      rideSessionService: { getRecoveryLogs: async () => [] },
      ticketService: {
        adminUpdateStatus: async (ticketId, payload) => {
          captured = { ticketId, payload };
          return {
            success: true,
            message: 'updated',
            data: { id: ticketId, status: payload.status },
          };
        },
      },
    },
  });

  const handler = router.get('PUT', '/api/v1/admin/tickets/:ticketId/status');
  const response = await handler({
    pathParams: { ticketId: 'ticket-2' },
    body: { status: 'RESOLVED', resolution: 'Handled' },
    headers: { 'x-admin-token': 'secret' },
  });

  assert.equal(captured.ticketId, 'ticket-2');
  assert.equal(captured.payload.status, 'RESOLVED');
  assert.equal(captured.payload.actorId, 'admin');
  assert.equal(response.data.success, true);
});

test('admin support message route supports internal notes', async () => {
  const router = createRouter();
  let captured = null;
  registerAdminSupportRoutes(router, {
    requireAdmin: () => null,
    services: {
      rideSessionService: { getRecoveryLogs: async () => [] },
      ticketService: {
        addMessage: async (ticketId, payload) => {
          captured = { ticketId, payload };
          return {
            success: true,
            message: 'sent',
            data: { ticketId },
          };
        },
      },
    },
  });

  const handler = router.get('POST', '/api/v1/admin/tickets/:ticketId/messages');
  const response = await handler({
    pathParams: { ticketId: 'ticket-3' },
    body: { content: 'Staff note', visibility: 'internal' },
    headers: { 'x-admin-token': 'secret' },
  });

  assert.equal(captured.ticketId, 'ticket-3');
  assert.equal(captured.payload.isAdmin, true);
  assert.equal(captured.payload.visibility, 'internal');
  assert.equal(response.status, 201);
});

test('admin can create past ride issue groups', async () => {
  const router = createRouter();
  let captured = null;
  registerAdminSupportRoutes(router, {
    requireAdmin: () => null,
    services: {
      rideSessionService: { getRecoveryLogs: async () => [] },
      ticketService: {
        adminCreatePastRideIssueGroup: async (payload) => {
          captured = payload;
          return {
            success: true,
            data: { id: 'group-1', ...payload },
          };
        },
      },
    },
  });

  const handler = router.get('POST', '/api/v1/admin/support/past-ride-issues/groups');
  const response = await handler({
    body: {
      title: 'Driver behavior',
      description: 'Behavior concerns',
      backendCategory: 'driver_vehicle_issue',
      sortOrder: 10,
      showDriverDetails: true,
      isActive: true,
    },
    headers: { 'x-admin-token': 'secret' },
  });

  assert.equal(captured.title, 'Driver behavior');
  assert.equal(captured.backendCategory, 'driver_vehicle_issue');
  assert.equal(captured.showDriverDetails, true);
  assert.equal(response.status, 201);
});

test('admin can update and delete past ride sub-issues', async () => {
  const router = createRouter();
  let updated = null;
  let deleted = null;
  registerAdminSupportRoutes(router, {
    requireAdmin: () => null,
    services: {
      rideSessionService: { getRecoveryLogs: async () => [] },
      ticketService: {
        adminUpdatePastRideSubIssue: async (subIssueId, payload) => {
          updated = { subIssueId, payload };
          return {
            success: true,
            data: { id: subIssueId, ...payload },
          };
        },
        adminDeletePastRideSubIssue: async (subIssueId) => {
          deleted = subIssueId;
          return {
            success: true,
            data: { id: subIssueId },
          };
        },
      },
    },
  });

  const updateHandler = router.get('PUT', '/api/v1/admin/support/past-ride-issues/sub-issues/:subIssueId');
  const updateResponse = await updateHandler({
    pathParams: { subIssueId: 'sub-2' },
    body: {
      title: 'Driver ignored my instructions',
      sortOrder: 30,
      isActive: false,
    },
    headers: { 'x-admin-token': 'secret' },
  });

  const deleteHandler = router.get('DELETE', '/api/v1/admin/support/past-ride-issues/sub-issues/:subIssueId');
  const deleteResponse = await deleteHandler({
    pathParams: { subIssueId: 'sub-2' },
    headers: { 'x-admin-token': 'secret' },
  });

  assert.equal(updated.subIssueId, 'sub-2');
  assert.equal(updated.payload.title, 'Driver ignored my instructions');
  assert.equal(updated.payload.isActive, false);
  assert.equal(updateResponse.data.success, true);
  assert.equal(deleted, 'sub-2');
  assert.equal(deleteResponse.data.success, true);
});
