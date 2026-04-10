import { Context } from 'hono';

import { getJsonObjectValue, getStringValue } from './utils';

const DEFAULT_CF_EMAIL_ROUTING_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const CF_EMAIL_ROUTING_ERROR_PREFIX = 'Cloudflare Email Routing';

const normalizeDomain = (value: string): string => value.trim().toLowerCase();

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

const isAuthenticationError = (payload: any): boolean => {
    return Array.isArray(payload?.errors)
        && payload.errors.some((item: any) => item?.code === 10000 || item?.message === 'Authentication error');
};

// Cloudflare Dashboard currently manages Email Routing subdomains through the same
// internal `/email/routing/{enable|disable}` endpoints, with a JSON body containing
// the fully-qualified subdomain name. These endpoints are intentionally wrapped here
// so the subdomain-specific behavior is isolated from the public zone-level docs.
const requestCloudflareEmailRoutingSubdomainAction = async (
    c: Context<HonoCustomType>,
    zoneId: string,
    action: 'enable' | 'disable',
    addressDomain: string,
): Promise<void> => {
    const apiToken = getStringValue(c.env.CF_EMAIL_ROUTING_API_TOKEN).trim();
    const authEmail = getStringValue(c.env.CF_EMAIL_ROUTING_AUTH_EMAIL).trim();
    const globalApiKey = getStringValue(c.env.CF_EMAIL_ROUTING_GLOBAL_API_KEY).trim();
    if (!apiToken && !(authEmail && globalApiKey)) {
        throw new Error(
            `${CF_EMAIL_ROUTING_ERROR_PREFIX} credentials are missing for action ${action} on ${addressDomain}`,
        );
    }

    const url = `${getEmailRoutingApiBaseUrl(c)}/zones/${zoneId}/email/routing/${action}`;
    const requestBody = JSON.stringify({
        name: addressDomain,
    });

    const tryActionWithHeaders = async (
        headers: Record<string, string>,
    ): Promise<{ ok: boolean, payload: any }> => {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
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
        ? await tryActionWithHeaders({
            'authorization': `Bearer ${apiToken}`,
        })
        : {
            ok: false,
            payload: null,
        };

    if (!result.ok && authEmail && globalApiKey && (!apiToken || isAuthenticationError(result.payload))) {
        result = await tryActionWithHeaders({
            'x-auth-email': authEmail,
            'x-auth-key': globalApiKey,
        });
    }

    if (!result.ok) {
        throw new Error(
            `${CF_EMAIL_ROUTING_ERROR_PREFIX} ${action} failed for ${addressDomain}: ${getErrorMessage(result.payload)}`,
        );
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

    await requestCloudflareEmailRoutingSubdomainAction(c, zoneId, 'enable', addressDomain);
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

    await requestCloudflareEmailRoutingSubdomainAction(c, zoneId, 'disable', addressDomain);
}
