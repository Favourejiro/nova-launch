import type { BasicInfoData } from '../components/TokenDeployForm/BasicInfoStep';

/**
 * Token template presets for Nova Launch deployment form.
 *
 * Available templates and their intended use cases:
 *
 * | id                 | Label                | Use Case                                                    |
 * |--------------------|----------------------|-------------------------------------------------------------|
 * | community          | Community Token      | DAOs, local groups, neighbourhood rewards programs          |
 * | creator            | Creator Fan Token    | Content creators rewarding subscribers/fans with utility    |
 * | startup            | Startup Equity Token | Early-stage startups issuing equity-like tokens to backers  |
 * | stablecoin-like    | Points & Rewards     | Loyalty points, in-app currency, non-transferable rewards   |
 *
 * Defaults are aligned with Stellar's token conventions:
 * - 7 decimals is the Stellar native asset precision and is the safest default.
 * - Initial supply is expressed as a whole-number string (no decimals) because the
 *   form field accepts raw integer input that is later scaled by the decimals value.
 * - adminWallet is intentionally left empty; the form fills it from the connected wallet.
 */

export interface TokenTemplate {
    id: string;
    label: string;
    description: string;
    /** lucide-react icon name (already imported in TemplateSelector) */
    icon: string;
    defaults: Omit<BasicInfoData, 'adminWallet'>;
}

export const TOKEN_TEMPLATES: TokenTemplate[] = [
    {
        id: 'community',
        label: 'Community Token',
        description: 'For DAOs, local communities, and neighbourhood reward programmes.',
        icon: 'Users',
        defaults: {
            name: 'Community Token',
            symbol: 'CMTY',
            decimals: 7,
            initialSupply: '1000000',
        },
    },
    {
        id: 'creator',
        label: 'Creator Fan Token',
        description: 'Let fans earn utility tokens from your content or community.',
        icon: 'Star',
        defaults: {
            name: 'Fan Token',
            symbol: 'FAN',
            decimals: 7,
            initialSupply: '10000000',
        },
    },
    {
        id: 'startup',
        label: 'Startup Equity Token',
        description: 'Issue equity-like tokens to early backers and team members.',
        icon: 'TrendingUp',
        defaults: {
            name: 'Equity Token',
            symbol: 'EQT',
            decimals: 2,
            initialSupply: '100000000',
        },
    },
    {
        id: 'rewards',
        label: 'Points & Rewards',
        description: 'In-app currency, loyalty points, or non-transferable reward credits.',
        icon: 'Gift',
        defaults: {
            name: 'Reward Points',
            symbol: 'PTS',
            decimals: 0,
            initialSupply: '500000000',
        },
    },
];
