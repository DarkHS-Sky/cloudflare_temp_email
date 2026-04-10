import { test, expect } from '@playwright/test';
import { TEST_DOMAIN, WORKER_URL_SUBDOMAIN } from '../../fixtures/test-helpers';

let originalCreateAddressStoredEnabled: boolean | undefined;

async function getAccountSettings(request: any) {
  const res = await request.get(`${WORKER_URL_SUBDOMAIN}/admin/account_settings`);
  expect(res.ok()).toBe(true);
  return await res.json();
}

function buildAccountSettingsPayload(
  current: any,
  addressCreationSettings?: { enableSubdomainMatch?: boolean | null },
) {
  return {
    blockList: current.blockList || [],
    sendBlockList: current.sendBlockList || [],
    verifiedAddressList: current.verifiedAddressList || [],
    fromBlockList: current.fromBlockList || [],
    noLimitSendAddressList: current.noLimitSendAddressList || [],
    emailRuleSettings: current.emailRuleSettings || {},
    ...(typeof addressCreationSettings !== 'undefined'
      ? { addressCreationSettings }
      : {}),
  };
}

async function saveSubdomainMatchSetting(
  request: any,
  enableSubdomainMatch: boolean | null,
) {
  const current = await getAccountSettings(request);
  const res = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/account_settings`, {
    data: buildAccountSettingsPayload(current, { enableSubdomainMatch }),
  });
  expect(res.ok()).toBe(true);
}

async function restoreSubdomainMatchSetting(request: any) {
  if (typeof originalCreateAddressStoredEnabled === 'boolean') {
    await saveSubdomainMatchSetting(request, originalCreateAddressStoredEnabled);
    return;
  }
  await saveSubdomainMatchSetting(request, null);
}

async function listCloudflareRoutingCalls(request: any) {
  const callsRes = await request.get(`${WORKER_URL_SUBDOMAIN}/admin/test/cloudflare_email_routing/calls`);
  expect(callsRes.ok()).toBe(true);
  const callsBody = await callsRes.json();
  return callsBody.calls;
}

async function queryAddresses(request: any, query: string) {
  const queryRes = await request.get(`${WORKER_URL_SUBDOMAIN}/admin/address`, {
    params: {
      query,
      limit: '20',
      offset: '0',
    },
  });
  expect(queryRes.ok()).toBe(true);
  return await queryRes.json();
}

test.describe('Random Subdomain Email Routing', () => {
  test.beforeAll(async ({ request }) => {
    if (!WORKER_URL_SUBDOMAIN) {
      return;
    }
    const createAddressSettings = await getAccountSettings(request);
    originalCreateAddressStoredEnabled = createAddressSettings.addressCreationSubdomainMatchStatus?.storedEnabled;
  });

  test.beforeEach(async ({ request }) => {
    test.skip(!WORKER_URL_SUBDOMAIN, 'WORKER_URL_SUBDOMAIN is not configured');

    const initialize = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/db_initialize`);
    expect(initialize.ok()).toBe(true);

    const migrate = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/db_migration`);
    expect(migrate.ok()).toBe(true);

    const resetAddresses = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/test/reset_addresses`);
    expect(resetAddresses.ok()).toBe(true);

    const reset = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/test/cloudflare_email_routing/reset`);
    expect(reset.ok()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    if (!WORKER_URL_SUBDOMAIN) {
      return;
    }
    await restoreSubdomainMatchSetting(request);
  });

  test('creating a random subdomain address provisions Cloudflare Email Routing', async ({ request }) => {
    const name = `routing${Date.now()}`;
    const res = await request.post(`${WORKER_URL_SUBDOMAIN}/api/new_address`, {
      data: { name, domain: TEST_DOMAIN, enableRandomSubdomain: true },
    });

    expect(res.ok()).toBe(true);
    const body = await res.json();
    const [localPart, domainPart] = body.address.split('@');

    expect(localPart).toBe(`tmp${name}`);
    expect(domainPart).toMatch(/^[a-z0-9]+\.test\.example\.com$/);

    const callsBody = await listCloudflareRoutingCalls(request);

    expect(callsBody).toHaveLength(1);
    expect(callsBody[0]).toMatchObject({
      action: 'enable',
      zoneId: 'test-zone-id',
      authorization: 'Bearer e2e-cloudflare-token',
      body: {
        name: domainPart,
      },
    });
  });

  test('create address fails and does not persist when subdomain provisioning fails', async ({ request }) => {
    const name = `routingfail${Date.now()}`;

    const failNextRes = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/test/cloudflare_email_routing/fail_next`, {
      data: { failNext: true },
    });
    expect(failNextRes.ok()).toBe(true);

    const res = await request.post(`${WORKER_URL_SUBDOMAIN}/api/new_address`, {
      data: { name, domain: TEST_DOMAIN, enableRandomSubdomain: true },
    });

    expect(res.ok()).toBe(false);
    expect(await res.text()).toContain('Cloudflare Email Routing');

    const queryRes = await request.get(`${WORKER_URL_SUBDOMAIN}/admin/address`, {
      params: {
        query: `tmp${name}`,
        limit: '20',
        offset: '0',
      },
    });
    expect(queryRes.ok()).toBe(true);
    const queryBody = await queryRes.json();
    expect(queryBody.results).toHaveLength(0);
  });

  test('deleting the last random subdomain address disables Cloudflare Email Routing', async ({ request }) => {
    const name = `routingdelete${Date.now()}`;
    const createRes = await request.post(`${WORKER_URL_SUBDOMAIN}/api/new_address`, {
      data: { name, domain: TEST_DOMAIN, enableRandomSubdomain: true },
    });
    expect(createRes.ok()).toBe(true);

    const body = await createRes.json();
    const [, domainPart] = body.address.split('@');

    const deleteRes = await request.delete(`${WORKER_URL_SUBDOMAIN}/api/delete_address`, {
      headers: { Authorization: `Bearer ${body.jwt}` },
    });
    expect(deleteRes.ok()).toBe(true);

    const calls = await listCloudflareRoutingCalls(request);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      action: 'disable',
      zoneId: 'test-zone-id',
      authorization: 'Bearer e2e-cloudflare-token',
      body: {
        name: domainPart,
      },
    });

    const queryBody = await queryAddresses(request, body.address);
    expect(queryBody.results).toHaveLength(0);
  });

  test('deleting one address keeps Cloudflare subdomain when sibling addresses still exist', async ({ request }) => {
    await saveSubdomainMatchSetting(request, true);

    const name = `routingsibling${Date.now()}`;
    const createRes = await request.post(`${WORKER_URL_SUBDOMAIN}/api/new_address`, {
      data: { name, domain: TEST_DOMAIN, enableRandomSubdomain: true },
    });
    expect(createRes.ok()).toBe(true);

    const firstBody = await createRes.json();
    const [, domainPart] = firstBody.address.split('@');

    const secondName = `adminsibling${Date.now()}`;
    const secondRes = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/new_address`, {
      data: { name: secondName, domain: domainPart },
    });
    expect(secondRes.ok()).toBe(true);
    const secondBody = await secondRes.json();

    try {
      const deleteRes = await request.delete(`${WORKER_URL_SUBDOMAIN}/api/delete_address`, {
        headers: { Authorization: `Bearer ${firstBody.jwt}` },
      });
      expect(deleteRes.ok()).toBe(true);

      const calls = await listCloudflareRoutingCalls(request);
      expect(calls.filter((call: any) => call.action === 'disable')).toHaveLength(0);

      const secondAddressQuery = await queryAddresses(request, secondBody.address);
      expect(secondAddressQuery.results).toHaveLength(1);
    } finally {
      await request.delete(`${WORKER_URL_SUBDOMAIN}/admin/delete_address/${secondBody.address_id}`);
    }
  });

  test('admin delete also disables Cloudflare Email Routing for the last random subdomain address', async ({ request }) => {
    const name = `routingadmindelete${Date.now()}`;
    const createRes = await request.post(`${WORKER_URL_SUBDOMAIN}/api/new_address`, {
      data: { name, domain: TEST_DOMAIN, enableRandomSubdomain: true },
    });
    expect(createRes.ok()).toBe(true);

    const body = await createRes.json();
    const [, domainPart] = body.address.split('@');

    const deleteRes = await request.delete(`${WORKER_URL_SUBDOMAIN}/admin/delete_address/${body.address_id}`);
    expect(deleteRes.ok()).toBe(true);

    const calls = await listCloudflareRoutingCalls(request);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      action: 'disable',
      body: {
        name: domainPart,
      },
    });
  });

  test('deleting a manually created subdomain address does not trigger Cloudflare cleanup', async ({ request }) => {
    await saveSubdomainMatchSetting(request, true);

    const manualDomain = `ops.${TEST_DOMAIN}`;
    const createRes = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/new_address`, {
      data: { name: `manualsub${Date.now()}`, domain: manualDomain },
    });
    expect(createRes.ok()).toBe(true);
    const body = await createRes.json();

    const deleteRes = await request.delete(`${WORKER_URL_SUBDOMAIN}/admin/delete_address/${body.address_id}`);
    expect(deleteRes.ok()).toBe(true);

    const calls = await listCloudflareRoutingCalls(request);
    expect(calls).toHaveLength(0);
  });

  test('delete failure keeps the random subdomain address record', async ({ request }) => {
    const name = `routingdeletefail${Date.now()}`;
    const createRes = await request.post(`${WORKER_URL_SUBDOMAIN}/api/new_address`, {
      data: { name, domain: TEST_DOMAIN, enableRandomSubdomain: true },
    });
    expect(createRes.ok()).toBe(true);

    const body = await createRes.json();

    const failNextRes = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/test/cloudflare_email_routing/fail_next`, {
      data: { failNext: true, action: 'disable' },
    });
    expect(failNextRes.ok()).toBe(true);

    const deleteRes = await request.delete(`${WORKER_URL_SUBDOMAIN}/api/delete_address`, {
      headers: { Authorization: `Bearer ${body.jwt}` },
    });
    expect(deleteRes.ok()).toBe(false);
    expect(await deleteRes.text()).toContain('Cloudflare Email Routing');

    const queryBody = await queryAddresses(request, body.address);
    expect(queryBody.results).toHaveLength(1);
  });

  test('batch cleanup reports failure when Cloudflare subdomain cleanup fails', async ({ request }) => {
    const randomCreateRes = await request.post(`${WORKER_URL_SUBDOMAIN}/api/new_address`, {
      data: { name: `batchfail${Date.now()}`, domain: TEST_DOMAIN, enableRandomSubdomain: true },
    });
    expect(randomCreateRes.ok()).toBe(true);
    const randomBody = await randomCreateRes.json();

    const normalCreateRes = await request.post(`${WORKER_URL_SUBDOMAIN}/api/new_address`, {
      data: { name: `batchok${Date.now()}`, domain: TEST_DOMAIN },
    });
    expect(normalCreateRes.ok()).toBe(true);
    const normalBody = await normalCreateRes.json();

    await request.post(`${WORKER_URL_SUBDOMAIN}/admin/test/cloudflare_email_routing/fail_next`, {
      data: { failNext: true, action: 'disable' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const cleanupRes = await request.post(`${WORKER_URL_SUBDOMAIN}/admin/cleanup`, {
      data: { cleanType: 'addressCreated', cleanDays: 0 },
    });
    expect(cleanupRes.ok()).toBe(false);

    const failedAddressQuery = await queryAddresses(request, randomBody.address);
    expect(failedAddressQuery.results).toHaveLength(1);

    const deletedAddressQuery = await queryAddresses(request, normalBody.address);
    expect(deletedAddressQuery.results).toHaveLength(0);
  });
});
