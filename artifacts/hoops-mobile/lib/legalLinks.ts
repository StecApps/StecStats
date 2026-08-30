const DEFAULT_PUBLIC_DOMAIN = 'stecstats.com';

export type LegalLinks = {
  privacy: string;
  terms: string;
};

function resolveDomain(domain?: string): string {
  return (domain ?? DEFAULT_PUBLIC_DOMAIN).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function getLegalLinks(domain = process.env.EXPO_PUBLIC_DOMAIN): LegalLinks {
  const baseUrl = `https://${resolveDomain(domain)}`;

  return {
    privacy: `${baseUrl}/privacy`,
    terms: `${baseUrl}/terms`,
  };
}

export const PUBLIC_LEGAL_LINKS = getLegalLinks();