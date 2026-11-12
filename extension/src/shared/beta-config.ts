declare const BEYIM_BETA_API: string;
declare const BEYIM_SAFARI: boolean;

export const betaApi = typeof BEYIM_BETA_API === 'string' ? BEYIM_BETA_API : '';
export const safari = typeof BEYIM_SAFARI === 'boolean' && BEYIM_SAFARI;

declare const BEYIM_DIRECT_GROQ: boolean;
export const directGroq = typeof BEYIM_DIRECT_GROQ === 'boolean' && BEYIM_DIRECT_GROQ;
