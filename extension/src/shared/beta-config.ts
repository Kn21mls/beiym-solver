declare const BEYIM_BETA_API: string;
declare const BEYIM_SAFARI: boolean;

export const betaApi = typeof BEYIM_BETA_API === 'string' ? BEYIM_BETA_API : '';
export const safari = typeof BEYIM_SAFARI === 'boolean' && BEYIM_SAFARI;
