import { Context } from 'hono'
import { getBooleanValue, getJsonSetting, saveSetting } from '../utils'

const E2E_CF_ROUTING_CALLS_KEY = '__e2e_cf_routing_calls__';
const E2E_CF_ROUTING_FAIL_NEXT_KEY = '__e2e_cf_routing_fail_next__';
const E2E_CF_ROUTING_FAIL_NEXT_ACTION_KEY = '__e2e_cf_routing_fail_next_action__';

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
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_ACTION_KEY, JSON.stringify(null));
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
    const { failNext, action } = await c.req.json();
    const normalizedAction = action === 'enable' || action === 'disable' ? action : null;
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_KEY, JSON.stringify(!!failNext));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_ACTION_KEY, JSON.stringify(normalizedAction));
    return c.json({ success: true, failNext: !!failNext, action: normalizedAction });
};

const shouldFailCloudflareEmailRoutingAction = async (
    c: Context<HonoCustomType>,
    action: 'enable' | 'disable',
): Promise<boolean> => {
    const failNext = await getJsonSetting<boolean>(c, E2E_CF_ROUTING_FAIL_NEXT_KEY);
    if (!failNext) {
        return false;
    }
    const failNextAction = await getJsonSetting<'enable' | 'disable' | null>(
        c,
        E2E_CF_ROUTING_FAIL_NEXT_ACTION_KEY,
    );
    if (failNextAction && failNextAction !== action) {
        return false;
    }
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_KEY, JSON.stringify(false));
    await saveSetting(c, E2E_CF_ROUTING_FAIL_NEXT_ACTION_KEY, JSON.stringify(null));
    return true;
};

const recordCloudflareEmailRoutingCall = async (
    c: Context<HonoCustomType>,
    action: 'enable' | 'disable',
    body: Record<string, unknown>,
) => {
    const calls = await getJsonSetting<any[]>(c, E2E_CF_ROUTING_CALLS_KEY) || [];
    calls.push({
        action,
        zoneId: c.req.param('zoneId'),
        authorization: c.req.header('authorization') || '',
        body,
    });
    await saveSetting(c, E2E_CF_ROUTING_CALLS_KEY, JSON.stringify(calls));
};

const buildCloudflareEmailRoutingMockFailureResponse = (action: 'enable' | 'disable') => ({
    success: false,
    errors: [{ code: 5000, message: `Mock Cloudflare Email Routing ${action} failure` }],
    messages: [],
    result: null,
});

const mockCloudflareEmailRoutingEnable = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const body = await c.req.json();
    await recordCloudflareEmailRoutingCall(c, 'enable', body);

    if (await shouldFailCloudflareEmailRoutingAction(c, 'enable')) {
        return c.json(buildCloudflareEmailRoutingMockFailureResponse('enable'), 500);
    }

    return c.json({
        success: true,
        errors: [],
        messages: [],
        result: {
            id: `mock-${Date.now()}`,
            name: body?.name || '',
            enabled: true,
            status: 'ready',
        },
    });
};

const mockCloudflareEmailRoutingDisable = async (c: Context<HonoCustomType>) => {
    if (!getBooleanValue(c.env.E2E_TEST_MODE)) {
        return c.text("Not available", 404);
    }
    const body = await c.req.json();
    await recordCloudflareEmailRoutingCall(c, 'disable', body);

    if (await shouldFailCloudflareEmailRoutingAction(c, 'disable')) {
        return c.json(buildCloudflareEmailRoutingMockFailureResponse('disable'), 500);
    }

    return c.json({
        success: true,
        errors: [],
        messages: [],
        result: {
            id: `mock-disable-${Date.now()}`,
            name: body?.name || '',
            enabled: false,
            status: 'disabled',
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
    mockCloudflareEmailRoutingEnable,
    mockCloudflareEmailRoutingDisable,
};
