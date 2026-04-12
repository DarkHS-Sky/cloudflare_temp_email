import { Context } from 'hono';

import { getJsonObjectValue, getStringValue } from './utils';

const DEFAULT_CF_EMAIL_ROUTING_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const CF_EMAIL_ROUTING_ERROR_PREFIX = 'Cloudflare Email Routing';
const EMAIL_ROUTING_SUBDOMAIN_NOT_FOUND_ERROR_CODE = 2033;
const DNS_RECORD_NOT_FOUND_ERROR_CODE = 81044;
const RANDOM_SUBDOMAIN_ROUTING_MX_CONTENTS = new Set([
    'route1.mx.cloudflare.net',
    'route2.mx.cloudflare.net',
    'route3.mx.cloudflare.net',
]);
const RANDOM_SUBDOMAIN_ROUTING_SPF_CONTENT = 'v=spf1 include:_spf.mx.cloudflare.net ~all';

type CloudflareApiResult = {
    ok: boolean,
    payload: any,
};

type CloudflareDnsRecord = {
    id?: string,
    name?: string,
    type?: string,
    content?: string,
    priority?: number,
    meta?: Record<string, unknown> | null,
};

const normalizeDomain = (value: string): string => value.trim().toLowerCase();

const normalizeTxtContent = (value: string): string => {
    return value.trim().replace(/^"+|"+$/g, '').toLowerCase();
};

const getEmailRoutingApiBaseUrl = (c: Context<HonoCustomType>): string => {
    const configuredBaseUrl = getStringValue(c.env.CF_EMAIL_ROUTING_API_BASE_URL).trim();
    return (configuredBaseUrl || DEFAULT_CF_EMAIL_ROUTING_API_BASE_URL).replace(/\/$/, '');
};

const getEmailRoutingZoneId = (
    c: Context<HonoCustomType>,
    domain: string,
): string => {
    const zoneMap = getJsonObjectValue<Record<string, string>>(c.env.CF_EMAIL_ROUTING_ZONE_MAP) || {};
    return getStringValue(zoneMap[normalizeDomain(domain)]).trim();
};

const getErrorMessage = (payload: any): string => {
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        return payload.errors
            .map((item: any) => item?.message || item?.code || 'unknown error')
            .join('; ');
    }
    return 'unknown error';
};

const hasErrorCode = (payload: any, code: number): boolean => {
    return Array.isArray(payload?.errors)
        && payload.errors.some((item: any) => item?.code === code);
};

const isAuthenticationError = (payload: any): boolean => {
    return Array.isArray(payload?.errors)
        && payload.errors.some((item: any) => item?.code === 10000 || item?.message === 'Authentication error');
};

const buildRequestUrl = (
    c: Context<HonoCustomType>,
    path: string,
    query?: Record<string, string | number | undefined>,
): string => {
    const url = new URL(`${getEmailRoutingApiBaseUrl(c)}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        url.searchParams.set(key, `${value}`);
    }
    return url.toString();
};

const executeCloudflareApiRequest = async (
    c: Context<HonoCustomType>,
    options: {
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path: string,
        body?: Record<string, unknown>,
        query?: Record<string, string | number | undefined>,
    },
): Promise<CloudflareApiResult> => {
    const apiToken = getStringValue(c.env.CF_EMAIL_ROUTING_API_TOKEN).trim();
    const authEmail = getStringValue(c.env.CF_EMAIL_ROUTING_AUTH_EMAIL).trim();
    const globalApiKey = getStringValue(c.env.CF_EMAIL_ROUTING_GLOBAL_API_KEY).trim();
    if (!apiToken && !(authEmail && globalApiKey)) {
        throw new Error(`${CF_EMAIL_ROUTING_ERROR_PREFIX} credentials are missing`);
    }

    const url = buildRequestUrl(c, options.path, options.query);
    const requestBody = options.body ? JSON.stringify(options.body) : undefined;

    const tryRequestWithHeaders = async (
        headers: Record<string, string>,
    ): Promise<CloudflareApiResult> => {
        const response = await fetch(url, {
            method: options.method,
            headers: {
                ...(requestBody ? { 'content-type': 'application/json' } : {}),
                ...headers,
            },
            body: requestBody,
        });
        const payload: any = await response.json().catch(() => null);
        return {
            ok: response.ok && !!payload?.success,
            payload,
        };
    };

    let result = apiToken
        ? await tryRequestWithHeaders({
            authorization: `Bearer ${apiToken}`,
        })
        : {
            ok: false,
            payload: null,
        };

    if (!result.ok && authEmail && globalApiKey && (!apiToken || isAuthenticationError(result.payload))) {
        result = await tryRequestWithHeaders({
            'x-auth-email': authEmail,
            'x-auth-key': globalApiKey,
        });
    }

    return result;
};

const throwCloudflareRequestError = (
    action: string,
    target: string,
    payload: any,
): never => {
    throw new Error(
        `${CF_EMAIL_ROUTING_ERROR_PREFIX} ${action} failed for ${target}: ${getErrorMessage(payload)}`,
    );
};

const provisionRandomSubdomainEmailRouting = async (
    c: Context<HonoCustomType>,
    zoneId: string,
    addressDomain: string,
): Promise<void> => {
    const result = await executeCloudflareApiRequest(c, {
        method: 'POST',
        path: `/zones/${zoneId}/email/routing/dns`,
        body: {
            name: addressDomain,
        },
    });
    if (!result.ok) {
        throwCloudflareRequestError('enable', addressDomain, result.payload);
    }
};

const unlockRandomSubdomainEmailRoutingDns = async (
    c: Context<HonoCustomType>,
    zoneId: string,
    addressDomain: string,
): Promise<boolean> => {
    const result = await executeCloudflareApiRequest(c, {
        method: 'PATCH',
        path: `/zones/${zoneId}/email/routing/dns`,
        body: {
            name: addressDomain,
        },
    });
    if (!result.ok && !hasErrorCode(result.payload, EMAIL_ROUTING_SUBDOMAIN_NOT_FOUND_ERROR_CODE)) {
        throwCloudflareRequestError('unlock dns', addressDomain, result.payload);
    }
    return result.ok;
};

const detachRandomSubdomainEmailRouting = async (
    c: Context<HonoCustomType>,
    zoneId: string,
    addressDomain: string,
): Promise<boolean> => {
    const result = await executeCloudflareApiRequest(c, {
        method: 'POST',
        path: `/zones/${zoneId}/email/routing/disable`,
        body: {
            name: addressDomain,
        },
    });
    if (!result.ok && !hasErrorCode(result.payload, EMAIL_ROUTING_SUBDOMAIN_NOT_FOUND_ERROR_CODE)) {
        throwCloudflareRequestError('disable', addressDomain, result.payload);
    }
    return result.ok;
};

const listDnsRecordsByName = async (
    c: Context<HonoCustomType>,
    zoneId: string,
    addressDomain: string,
): Promise<CloudflareDnsRecord[]> => {
    const result = await executeCloudflareApiRequest(c, {
        method: 'GET',
        path: `/zones/${zoneId}/dns_records`,
        query: {
            per_page: 100,
            name: addressDomain,
        },
    });
    if (!result.ok) {
        throwCloudflareRequestError('list dns records', addressDomain, result.payload);
    }
    return Array.isArray(result.payload?.result) ? result.payload.result : [];
};

const deleteDnsRecord = async (
    c: Context<HonoCustomType>,
    zoneId: string,
    recordId: string,
    addressDomain: string,
): Promise<void> => {
    const result = await executeCloudflareApiRequest(c, {
        method: 'DELETE',
        path: `/zones/${zoneId}/dns_records/${encodeURIComponent(recordId)}`,
    });
    if (!result.ok && !hasErrorCode(result.payload, DNS_RECORD_NOT_FOUND_ERROR_CODE)) {
        throwCloudflareRequestError('delete dns record', addressDomain, result.payload);
    }
};

const isManagedRandomSubdomainDnsRecord = (
    addressDomain: string,
    record: CloudflareDnsRecord,
): boolean => {
    if (!record.id || normalizeDomain(record.name || '') !== normalizeDomain(addressDomain)) {
        return false;
    }
    if (record.type === 'MX') {
        return RANDOM_SUBDOMAIN_ROUTING_MX_CONTENTS.has(normalizeDomain(record.content || ''));
    }
    if (record.type === 'TXT') {
        return normalizeTxtContent(record.content || '') === RANDOM_SUBDOMAIN_ROUTING_SPF_CONTENT;
    }
    return false;
};

const rollbackRandomSubdomainCleanup = async (
    c: Context<HonoCustomType>,
    zoneId: string,
    addressDomain: string,
): Promise<void> => {
    try {
        await provisionRandomSubdomainEmailRouting(c, zoneId, addressDomain);
    } catch (rollbackError) {
        console.error('rollback random subdomain Cloudflare Email Routing cleanup failed', rollbackError);
    }
};

export const isCloudflareEmailRoutingProvisionError = (error: unknown): boolean => {
    return error instanceof Error && error.message.startsWith(CF_EMAIL_ROUTING_ERROR_PREFIX);
};

export const ensureRandomSubdomainEmailRouting = async (
    c: Context<HonoCustomType>,
    addressDomain: string,
    baseDomain: string,
): Promise<void> => {
    const zoneId = getEmailRoutingZoneId(c, baseDomain);
    if (!zoneId || normalizeDomain(addressDomain) === normalizeDomain(baseDomain)) {
        return;
    }

    await provisionRandomSubdomainEmailRouting(c, zoneId, addressDomain);
}

export const disableRandomSubdomainEmailRouting = async (
    c: Context<HonoCustomType>,
    addressDomain: string,
    baseDomain: string,
): Promise<void> => {
    const zoneId = getEmailRoutingZoneId(c, baseDomain);
    if (!zoneId || normalizeDomain(addressDomain) === normalizeDomain(baseDomain)) {
        return;
    }

    let shouldRollback = false;
    try {
        shouldRollback = await unlockRandomSubdomainEmailRoutingDns(c, zoneId, addressDomain);

        shouldRollback = await detachRandomSubdomainEmailRouting(c, zoneId, addressDomain) || shouldRollback;

        const dnsRecords = await listDnsRecordsByName(c, zoneId, addressDomain);
        const managedDnsRecords = dnsRecords.filter((record) => {
            return isManagedRandomSubdomainDnsRecord(addressDomain, record);
        });
        if (managedDnsRecords.length > 0) {
            shouldRollback = true;
        }
        for (const record of managedDnsRecords) {
            await deleteDnsRecord(c, zoneId, record.id!, addressDomain);
        }
    } catch (error) {
        if (shouldRollback) {
            await rollbackRandomSubdomainCleanup(c, zoneId, addressDomain);
        }
        throw error;
    }
}
