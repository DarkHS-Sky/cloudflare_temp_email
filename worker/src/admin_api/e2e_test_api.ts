import { Context } from 'hono'
import { getBooleanValue, getJsonSetting, saveSetting } from '../utils'

const E2E_CF_ROUTING_CALLS_KEY = '__e2e_cf_routing_calls__';
const E2E_CF_ROUTING_FAIL_NEXT_KEY = '__e2e_cf_routing_fail_next__';
const E2E_CF_ROUTING_FAIL_NEXT_PHASE_KEY = '__e2e_cf_routing_fail_next_phase__';
const E2E_CF_ROUTING_FAIL_NEXT_REQUEST_ACTION_KEY = '__e2e_cf_routing_fail_next_request_action__';
const E2E_CF_ROUTING_STATE_KEY = '__e2e_cf_routing_state__';

// Direct DB insert — bypasses the email() handler.
const seedMail = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const { address, source, raw, message_id } = await c.req.json();
    if (!address || !raw) {
        return c.text("address and raw are required", 400);
    }
    if (raw.length > 1_000_000) {
        return c.text("raw content too large", 400);
    }
    if (message_id && message_id.length > 255) {
        return c.text("message_id too long", 400);
    }
    const msgId = message_id || `<e2e-${Date.now()}@test>`;
    const { success } = await c.env.DB.prepare(
        `INSERT INTO raw_mails (message_id, source, address, raw, created_at)`
        + ` VALUES (?, ?, ?, ?, datetime('now'))`
    ).bind(msgId, source || address, address, raw).run();
    return c.json({ success });
};

// Exercises the real email() handler with a mock ForwardableEmailMessage.
const receiveMail = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const { from, to, raw } = await c.req.json();
    if (!from || !to || !raw) {
        return c.text("from, to and raw are required", 400);
    }

    // Parse MIME headers (unfold continuation lines, extract key:value pairs)
    const headerSection = raw.substring(0, Math.max(0, raw.indexOf('\r\n\r\n')));
    const headers = new Headers();
    for (const line of headerSection.replace(/\r\n(?=[ \t])/g, ' ').split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) headers.append(line.substring(0, idx).trim(), line.substring(idx + 1).trim());
    }
    if (!headers.has('Message-ID')) headers.set('Message-ID', `<e2e-${Date.now()}@test>`);

    const rawBytes = new TextEncoder().encode(raw);
    const state = { rejected: undefined as string | undefined, replyCalled: false };
    const mockMessage: ForwardableEmailMessage = {
        from, to, headers,
        rawSize: rawBytes.byteLength,
        raw: new ReadableStream({ start(ctrl) { ctrl.enqueue(rawBytes); ctrl.close(); } }),
        setReject(reason: string) { state.rejected = reason; },
        forward: async () => ({ messageId: '' }),
        reply: async () => { state.replyCalled = true; return { messageId: '' }; },
    };
    const { email: emailHandler } = await import('../email');
    await emailHandler(mockMessage, c.env, { waitUntil: () => {}, passThroughOnException: () => {} });

    return c.json({ success: !state.rejected, replyCalled: state.replyCalled, ...(state.rejected ? { rejected: state.rejected } : {}) });
};

const resetAddressData = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM raw_mails`),
        c.env.DB.prepare(`DELETE FROM sendbox`),
        c.env.DB.prepare(`DELETE FROM auto_reply_mails`),
        c.env.DB.prepare(`DELETE FROM address_sender`),
        c.env.DB.prepare(`DELETE FROM users_address`),
        c.env.DB.prepare(`DELETE FROM managed_random_subdomains`),
        c.env.DB.prepare(`DELETE FROM address`),
    ]);
    return c.json({ success: true });
};

const resetCloudflareEmailRoutingMock = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    await saveSetting(c, E2E_CF_ROUTING_CALLS_KEY, JSON.stringify([]));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_KEY, JSON.stringify(false));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_PHASE_KEY, JSON.stringify(null));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_REQUEST_ACTION_KEY, JSON.stringify(null));
    await saveSetting(c, E2E_CF_ROUTING_STATE_KEY, JSON.stringify({
        subdomains: {},
        dnsRecords: {},
    }));
    return c.json({ success: true });
};

const getCloudflareEmailRoutingCalls = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const calls = await getJsonSetting<any[]>(c, E2E_CF_ROUTING_CALLS_KEY) || [];
    return c.json({ calls });
};

const setCloudflareEmailRoutingMockFailure = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const { failNext, action, requestAction } = await c.req.json();
    const normalizedPhase = action === 'enable' || action === 'disable' ? action : null;
    const normalizedRequestAction = typeof requestAction === 'string' && requestAction.trim()
        ? requestAction.trim()
        : null;
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_KEY, JSON.stringify(!!failNext));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_PHASE_KEY, JSON.stringify(normalizedPhase));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_REQUEST_ACTION_KEY, JSON.stringify(normalizedRequestAction));
    return c.json({
        success: true,
        failNext: !!failNext,
        action: normalizedPhase,
        requestAction: normalizedRequestAction,
    });
};

const shouldFailCloudflareEmailRoutingAction = async (
    c: Context<HonoCustomType>,
    phase: 'enable' | 'disable',
    requestAction: string,
): Promise<boolean> => {
    const failNext = await getJsonSetting<boolean>(c, E2E_CF_ROUTING_FAIL_NEXT_KEY);
    if (!failNext) {
        return false;
    }
    const failNextPhase = await getJsonSetting<'enable' | 'disable' | null>(
        c,
        E2E_CF_ROUTING_FAIL_NEXT_PHASE_KEY,
    );
    if (failNextPhase && failNextPhase !== phase) {
        return false;
    }
    const failNextRequestAction = await getJsonSetting<string | null>(
        c,
        E2E_CF_ROUTING_FAIL_NEXT_REQUEST_ACTION_KEY,
    );
    if (failNextRequestAction && failNextRequestAction !== requestAction) {
        return false;
    }
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_KEY, JSON.stringify(false));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_PHASE_KEY, JSON.stringify(null));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_REQUEST_ACTION_KEY, JSON.stringify(null));
    return true;
};

type MockCloudflareRoutingCall = {
    action: string,
    phase: 'enable' | 'disable',
    method: string,
    path: string,
    zoneId: string,
    authorization: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
};

type MockCloudflareSubdomain = {
    id: string,
    tag: string,
    name: string,
    enabled: boolean,
    created: string,
    modified: string,
    status: 'ready' | 'unlocked',
};

type MockCloudflareDnsRecord = {
    id: string,
    name: string,
    type: 'MX' | 'TXT',
    content: string,
    priority?: number,
    meta?: Record<string, unknown>,
};

type MockCloudflareState = {
    subdomains: Record<string, MockCloudflareSubdomain>,
    dnsRecords: Record<string, MockCloudflareDnsRecord[]>,
};

const generateMockId = (): string => {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const getNowIso = (): string => new Date().toISOString();

const getMockCloudflareState = async (
    c: Context<HonoCustomType>,
): Promise<MockCloudflareState> => {
    return await getJsonSetting<MockCloudflareState>(c, E2E_CF_ROUTING_STATE_KEY) || {
        subdomains: {},
        dnsRecords: {},
    };
};

const saveMockCloudflareState = async (
    c: Context<HonoCustomType>,
    state: MockCloudflareState,
): Promise<void> => {
    await saveSetting(c, E2E_CF_ROUTING_STATE_KEY, JSON.stringify(state));
};

const buildManagedMockDnsRecords = (
    name: string,
    locked: boolean,
): MockCloudflareDnsRecord[] => {
    const mxMeta = locked ? { email_routing: true, read_only: true } : {};
    return [
        {
            id: generateMockId(),
            name,
            type: 'MX',
            content: 'route1.mx.cloudflare.net',
            priority: 13,
            meta: mxMeta,
        },
        {
            id: generateMockId(),
            name,
            type: 'MX',
            content: 'route2.mx.cloudflare.net',
            priority: 54,
            meta: mxMeta,
        },
        {
            id: generateMockId(),
            name,
            type: 'MX',
            content: 'route3.mx.cloudflare.net',
            priority: 63,
            meta: mxMeta,
        },
        {
            id: generateMockId(),
            name,
            type: 'TXT',
            content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
            meta: {},
        },
    ];
};

const upsertManagedMockDnsRecords = (
    state: MockCloudflareState,
    name: string,
    locked: boolean,
) => {
    const existingRecords = state.dnsRecords[name] || [];
    const requiredRecords = buildManagedMockDnsRecords(name, locked);
    state.dnsRecords[name] = requiredRecords.map((requiredRecord) => {
        const matchedRecord = existingRecords.find((record) => {
            return record.type === requiredRecord.type
                && record.content === requiredRecord.content
                && (record.priority || 0) === (requiredRecord.priority || 0);
        });
        return matchedRecord
            ? {
                ...matchedRecord,
                meta: requiredRecord.meta || {},
            }
            : requiredRecord;
    });
};

const unlockManagedMockDnsRecords = (
    state: MockCloudflareState,
    name: string,
) => {
    const records = state.dnsRecords[name] || [];
    state.dnsRecords[name] = records.map((record) => {
        if (record.type !== 'MX') {
            return record;
        }
        return {
            ...record,
            meta: {},
        };
    });
};

const removeManagedMockTxtRecords = (
    state: MockCloudflareState,
    name: string,
) => {
    const records = state.dnsRecords[name] || [];
    state.dnsRecords[name] = records.filter((record) => {
        return !(record.type === 'TXT' && record.content === '"v=spf1 include:_spf.mx.cloudflare.net ~all"');
    });
};

const getQueryObject = (c: Context<HonoCustomType>): Record<string, string> => {
    return Object.fromEntries(new URL(c.req.url).searchParams.entries());
};

const recordCloudflareEmailRoutingCall = async (
    c: Context<HonoCustomType>,
    phase: 'enable' | 'disable',
    action: string,
    body?: Record<string, unknown>,
) => {
    const calls = await getJsonSetting<MockCloudflareRoutingCall[]>(c, E2E_CF_ROUTING_CALLS_KEY) || [];
    calls.push({
        action,
        phase,
        method: c.req.method,
        path: c.req.path,
        zoneId: c.req.param('zoneId'),
        authorization: c.req.header('authorization') || '',
        body,
        query: getQueryObject(c),
    });
    await saveSetting(c, E2E_CF_ROUTING_CALLS_KEY, JSON.stringify(calls));
};

const buildCloudflareEmailRoutingMockFailureResponse = (phase: 'enable' | 'disable', action: string) => ({
    success: false,
    errors: [{ code: 5000, message: `Mock Cloudflare Email Routing ${phase}/${action} failure` }],
    messages: [],
    result: null,
});

const buildMockSubdomainNotFoundResponse = () => ({
    success: false,
    errors: [{ code: 2033, message: 'Subdomain not found' }],
    messages: [{ code: 2033, message: 'Subdomain not found' }],
    result: null,
});

const buildMockDnsRecordNotFoundResponse = () => ({
    success: false,
    errors: [{ code: 81044, message: 'Record does not exist.' }],
    messages: [],
    result: null,
});

const mockCloudflareEmailRoutingProvisionDns = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const body = await c.req.json();
    await recordCloudflareEmailRoutingCall(c, 'enable', 'provision_dns', body);

    if (await shouldFailCloudflareEmailRoutingAction(c, 'enable', 'provision_dns')) {
        return c.json(buildCloudflareEmailRoutingMockFailureResponse('enable', 'provision_dns'), 500);
    }

    const state = await getMockCloudflareState(c);
    const now = getNowIso();
    const name = `${body?.name || ''}`;
    const existingSubdomain = state.subdomains[name];
    const subdomain = {
        id: existingSubdomain?.id || generateMockId(),
        tag: existingSubdomain?.tag || generateMockId(),
        name,
        enabled: true,
        created: existingSubdomain?.created || now,
        modified: now,
        status: 'ready' as const,
    };
    state.subdomains[name] = subdomain;
    upsertManagedMockDnsRecords(state, name, true);
    await saveMockCloudflareState(c, state);

    return c.json({
        success: true,
        errors: [],
        messages: [],
        result: subdomain,
    });
};

const mockCloudflareEmailRoutingUnlockDns = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const body = await c.req.json();
    await recordCloudflareEmailRoutingCall(c, 'disable', 'unlock_dns', body);

    if (await shouldFailCloudflareEmailRoutingAction(c, 'disable', 'unlock_dns')) {
        return c.json(buildCloudflareEmailRoutingMockFailureResponse('disable', 'unlock_dns'), 500);
    }

    const state = await getMockCloudflareState(c);
    const name = `${body?.name || ''}`;
    const subdomain = state.subdomains[name];
    if (!subdomain) {
        return c.json(buildMockSubdomainNotFoundResponse());
    }
    const now = getNowIso();
    state.subdomains[name] = {
        ...subdomain,
        modified: now,
        status: 'unlocked',
    };
    unlockManagedMockDnsRecords(state, name);
    await saveMockCloudflareState(c, state);

    return c.json({
        success: true,
        errors: [],
        messages: [],
        result: state.subdomains[name],
    });
};

const mockCloudflareEmailRoutingDisable = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const body = await c.req.json();
    await recordCloudflareEmailRoutingCall(c, 'disable', 'disable_subdomain', body);

    if (await shouldFailCloudflareEmailRoutingAction(c, 'disable', 'disable_subdomain')) {
        return c.json(buildCloudflareEmailRoutingMockFailureResponse('disable', 'disable_subdomain'), 500);
    }

    const state = await getMockCloudflareState(c);
    const name = `${body?.name || ''}`;
    if (!state.subdomains[name]) {
        return c.json(buildMockSubdomainNotFoundResponse());
    }
    delete state.subdomains[name];
    removeManagedMockTxtRecords(state, name);
    await saveMockCloudflareState(c, state);

    return c.json({
        success: true,
        errors: [],
        messages: [],
        result: null,
    });
};

const mockCloudflareDnsRecordList = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    await recordCloudflareEmailRoutingCall(c, 'disable', 'list_dns_records');

    if (await shouldFailCloudflareEmailRoutingAction(c, 'disable', 'list_dns_records')) {
        return c.json(buildCloudflareEmailRoutingMockFailureResponse('disable', 'list_dns_records'), 500);
    }

    const state = await getMockCloudflareState(c);
    const query = getQueryObject(c);
    const records = query.name
        ? (state.dnsRecords[query.name] || [])
        : Object.values(state.dnsRecords).flat();
    return c.json({
        success: true,
        errors: [],
        messages: [],
        result: records,
        result_info: {
            page: 1,
            per_page: records.length || 100,
            count: records.length,
            total_count: records.length,
            total_pages: 1,
        },
    });
};

const mockCloudflareDnsRecordDelete = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    await recordCloudflareEmailRoutingCall(c, 'disable', 'delete_dns_record', {
        recordId: c.req.param('recordId'),
    });

    if (await shouldFailCloudflareEmailRoutingAction(c, 'disable', 'delete_dns_record')) {
        return c.json(buildCloudflareEmailRoutingMockFailureResponse('disable', 'delete_dns_record'), 500);
    }

    const state = await getMockCloudflareState(c);
    const recordId = c.req.param('recordId');
    let deleted = false;
    for (const [name, records] of Object.entries(state.dnsRecords)) {
        const nextRecords = records.filter((record) => record.id !== recordId);
        if (nextRecords.length !== records.length) {
            state.dnsRecords[name] = nextRecords;
            deleted = true;
        }
    }
    if (!deleted) {
        return c.json(buildMockDnsRecordNotFoundResponse());
    }
    await saveMockCloudflareState(c, state);

    return c.json({
        success: true,
        errors: [],
        messages: [],
        result: {
            id: recordId,
        },
    });
};

export default {
    seedMail,
    receiveMail,
    resetAddressData,
    resetCloudflareEmailRoutingMock,
    getCloudflareEmailRoutingCalls,
    setCloudflareEmailRoutingMockFailure,
    mockCloudflareEmailRoutingProvisionDns,
    mockCloudflareEmailRoutingUnlockDns,
    mockCloudflareEmailRoutingDisable,
    mockCloudflareDnsRecordList,
    mockCloudflareDnsRecordDelete,
};
